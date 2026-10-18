"""Local speech recognition engines for transcribe.py.

Each engine loads its model once and transcribes one 16 kHz mono PCM16 WAV at a
time; transcribe.py runs them from a single queue, since two requests at once
would only compete for the same CPU (or GPU). Every engine answers
{"text", "language"} with language in the app's form ("pt-BR", "en-US") and
raises Unrecognized when the audio has no words.
"""
import array
import atexit
import glob
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave

# Frequent function words. A recognizer returns a confident-looking transcript even
# for the wrong language, so the vocabulary is a second signal besides confidence.
STOPWORDS = {
    "pt": {"de", "que", "o", "a", "os", "as", "do", "da", "em", "um", "uma", "para", "com", "não",
           "é", "eu", "você", "isso", "se", "na", "no", "mais", "como", "mas", "por", "ele", "ela",
           "tem", "meu", "minha", "sua", "seu", "está", "foi", "são", "também", "então", "aqui"},
    "en": {"the", "and", "is", "you", "to", "of", "it", "in", "that", "what", "i", "a", "an", "do",
           "this", "are", "was", "for", "with", "have", "how", "can", "your", "my", "we", "be",
           "not", "on", "about", "would", "so", "me", "there", "they", "tell", "why", "will"},
}


class Unrecognized(Exception):
    """The audio has no recognizable words."""


class EngineError(Exception):
    """The engine could not load or run; the app falls back to Google."""

    def __init__(self, message, code="engine_error"):
        super().__init__(message)
        self.code = code


def base_language(language):
    return language.split("-")[0].lower()


def stopword_ratio(language, text):
    words = re.findall(r"[^\W\d_]+", text.lower())
    vocabulary = STOPWORDS.get(base_language(language), set())
    return sum(word in vocabulary for word in words) / len(words) if words else 0


def full_language(code, languages):
    """Maps a recognizer's code ("pt") back to the requested form ("pt-BR"), or None."""
    for language in languages:
        if base_language(language) == code:
            return language
    return None


def read_wav(path):
    """Samples of a 16 kHz mono PCM16 WAV as float32 in [-1, 1] (numpy when available)."""
    with wave.open(path, "rb") as source:
        frames = source.readframes(source.getnframes())
    try:
        import numpy as np
        return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    except ImportError:
        samples = array.array("h", frames)
        return [sample / 32768.0 for sample in samples]


def read_pcm(path):
    with wave.open(path, "rb") as source:
        return source.readframes(source.getnframes())


def cpu_threads():
    # Half the logical CPUs (the physical cores, usually), leaving room for the app.
    return max(1, min(8, (os.cpu_count() or 2) // 2))


def find_one(directory, pattern):
    matches = sorted(glob.glob(os.path.join(directory, "**", pattern), recursive=True))
    if not matches:
        raise EngineError(f"Arquivo {pattern} não encontrado em {directory}. Baixe o modelo de novo.", "model_missing")
    return matches[0]


def require_dir(path, label):
    if not path or not os.path.isdir(path):
        raise EngineError(f"O modelo {label} não está instalado. Baixe-o em Menu → Reconhecimento de voz.", "model_missing")
    return path


def import_package(module, pip_name):
    try:
        return __import__(module)
    except ImportError:
        raise EngineError(f"O pacote Python {pip_name} não está instalado.", "package_missing")


class FasterWhisperEngine:
    """Whisper small or base through faster-whisper (CTranslate2), int8 on the CPU."""

    name = "faster-whisper"

    def __init__(self, config):
        self.model_dir = require_dir(config.get("modelDir"), "Whisper")
        self.device = "CPU"

    def load(self):
        faster_whisper = import_package("faster_whisper", "faster-whisper")
        self.model = faster_whisper.WhisperModel(self.model_dir, device="cpu", compute_type="int8",
                                                 cpu_threads=cpu_threads())

    def run(self, audio, language):
        # Greedy decoding without timestamps: a live tail is re-sent every second, so speed wins.
        segments, info = self.model.transcribe(audio, language=language, beam_size=1, without_timestamps=True,
                                               condition_on_previous_text=False, vad_filter=False)
        return " ".join(segment.text.strip() for segment in segments).strip(), info

    def transcribe(self, wav_path, languages):
        audio = read_wav(wav_path)
        if len(languages) == 1:
            text, _ = self.run(audio, base_language(languages[0]))
            language = languages[0]
        else:
            text, info = self.run(audio, None)
            language = full_language(info.language, languages)
            if language is None:
                # Whisper heard another language: retry in the likeliest requested one.
                probabilities = dict(info.all_language_probs or [])
                language = max(languages, key=lambda item: probabilities.get(base_language(item), 0))
                text, _ = self.run(audio, base_language(language))
        if not text:
            raise Unrecognized()
        return {"text": text, "language": language}


class VoskEngine:
    """Vosk (Kaldi) with one small model per language. It cannot detect the language,
    so in auto mode every installed requested model transcribes the audio and the one
    with the best word confidence plus vocabulary match wins, like the Google path."""

    name = "vosk"

    def __init__(self, config):
        self.model_dirs = {language: path for language, path in (config.get("modelDirs") or {}).items()
                           if path and os.path.isdir(path)}
        if not self.model_dirs:
            raise EngineError("Nenhum modelo do Vosk está instalado. Baixe o de português ou o de inglês.", "model_missing")
        self.device = "CPU"

    def load(self):
        vosk = import_package("vosk", "vosk")
        vosk.SetLogLevel(-1)
        self.vosk = vosk
        self.models = {language: vosk.Model(path) for language, path in self.model_dirs.items()}

    def recognize(self, language, pcm):
        recognizer = self.vosk.KaldiRecognizer(self.models[language], 16000)
        recognizer.SetWords(True)
        recognizer.AcceptWaveform(pcm)
        result = json.loads(recognizer.FinalResult())
        text = result.get("text", "").strip()
        if not text:
            return None
        words = result.get("result") or []
        confidence = sum(word.get("conf", 0.6) for word in words) / len(words) if words else 0.6
        return {"text": text, "language": language, "score": confidence + 0.5 * stopword_ratio(language, text)}

    def transcribe(self, wav_path, languages):
        available = [language for language in languages if language in self.models]
        if not available:
            missing = ", ".join(languages)
            raise EngineError(f"Falta o modelo do Vosk para {missing}.", "model_missing")
        pcm = read_pcm(wav_path)
        best = None
        for language in available:
            result = self.recognize(language, pcm)
            if result and (best is None or result["score"] > best["score"]):
                best = result
        if not best:
            raise Unrecognized()
        return {"text": best["text"], "language": best["language"]}


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def die_with_parent():
    # Linux: the server dies with this worker even if the worker is killed with SIGKILL.
    try:
        import ctypes
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:
        pass


def multipart(fields, file_field, file_path):
    boundary = uuid.uuid4().hex
    parts = []
    for key, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    with open(file_path, "rb") as source:
        data = source.read()
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="audio.wav"\r\n'
                 f'Content-Type: audio/wav\r\n\r\n'.encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


class WhisperCppEngine:
    """Whisper large-v3-turbo through whisper.cpp's whisper-server, which keeps the
    model loaded. On the GPU through Vulkan when the build has it; if the GPU fails
    to start, the server is started again on the CPU."""

    name = "whisper-turbo"

    def __init__(self, config):
        self.model = config.get("modelFile")
        if not self.model or not os.path.isfile(self.model):
            raise EngineError("O modelo Whisper large-v3-turbo não está instalado.", "model_missing")
        self.binary = config.get("whisperServer")
        if not self.binary or not os.path.isfile(self.binary):
            raise EngineError("O whisper-server (whisper.cpp) não foi encontrado.", "binary_missing")
        self.process = None
        self.device = None
        self.log = []

    def start(self, gpu):
        self.port = free_port()
        args = [self.binary, "-m", self.model, "--host", "127.0.0.1", "--port", str(self.port),
                "-t", str(cpu_threads()), "-l", "auto", "-nt"]
        if not gpu:
            args.append("-ng")
        self.log = []
        self.process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                        preexec_fn=die_with_parent if sys.platform.startswith("linux") else None)
        import threading
        threading.Thread(target=self.read_log, args=(self.process,), daemon=True).start()
        deadline = time.time() + 120
        while time.time() < deadline:
            if self.process.poll() is not None:
                return False
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/", timeout=1).read()
                return True
            except (urllib.error.URLError, ConnectionError, socket.timeout):
                time.sleep(0.2)
            except urllib.error.HTTPError:
                return True
        return False

    def read_log(self, process):
        for raw in process.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            if len(self.log) < 400:
                self.log.append(line)

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()

    def load(self):
        atexit.register(self.stop)
        if self.start(gpu=True):
            gpu = next((line for line in self.log if "ggml_vulkan: 0 =" in line or "using Vulkan" in line), None)
            self.device = "GPU (Vulkan)" if gpu else "CPU"
            if gpu:
                match = re.search(r"ggml_vulkan: 0 = ([^|(]+)", gpu)
                if match:
                    self.device = f"GPU (Vulkan): {match.group(1).strip()}"
            return
        self.stop()
        if self.start(gpu=False):
            self.device = "CPU (a GPU falhou ao iniciar)"
            return
        self.stop()
        tail = " / ".join(self.log[-3:])
        raise EngineError(f"O whisper-server não iniciou. {tail}".strip())

    def run(self, wav_path, language):
        body, content_type = multipart({"response_format": "verbose_json", "temperature": "0", "language": language},
                                       "file", wav_path)
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/inference", data=body,
                                         headers={"Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                result = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, ConnectionError, socket.timeout) as error:
            if self.process.poll() is not None:
                raise EngineError("O whisper-server foi encerrado.")
            raise EngineError(f"Falha no whisper-server: {error}")
        if "error" in result:
            raise EngineError(f"Falha no whisper-server: {result['error']}")
        return result.get("text", "").strip(), result.get("language")

    def transcribe(self, wav_path, languages):
        if len(languages) == 1:
            text, _ = self.run(wav_path, base_language(languages[0]))
            language = languages[0]
        else:
            text, detected = self.run(wav_path, "auto")
            language = full_language(WHISPER_CODES.get(detected, detected), languages)
            if language is None:
                # Whisper heard another language: retry in the preferred requested one.
                language = languages[0]
                text, _ = self.run(wav_path, base_language(language))
        # whisper.cpp marks silence and noise like "[BLANK_AUDIO]" or "(música)".
        text = re.sub(r"\[[^\]]*\]|\([^)]*\)", "", text).strip()
        if not text:
            raise Unrecognized()
        return {"text": text, "language": language}


# whisper-server reports the language by name in some versions.
WHISPER_CODES = {"portuguese": "pt", "english": "en"}

ENGINES = {
    WhisperCppEngine.name: WhisperCppEngine,
    FasterWhisperEngine.name: FasterWhisperEngine,
    VoskEngine.name: VoskEngine,
}


def create_engine(config):
    engine_class = ENGINES.get(config.get("engine"))
    if not engine_class:
        raise EngineError(f"Motor de reconhecimento desconhecido: {config.get('engine')}")
    engine = engine_class(config)
    engine.load()
    return engine
