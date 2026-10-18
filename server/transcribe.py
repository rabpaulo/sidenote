#!/usr/bin/env python3
"""Speech recognition worker.

  transcribe.py <audio> [languages]          one file, with Google's free recognizer
  transcribe.py --serve [--config <json>]    long-lived worker (see serve())

The config selects the engine: {"engine": "google"} (default) or a local one from
speech_engines.py with its model paths. Google requests run concurrently; local
ones run one at a time, in order, since they share the CPU (or GPU).
"""
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor

from speech_engines import EngineError, Unrecognized, create_engine, stopword_ratio


def score(language, response):
    alternatives = response.get("alternative") if isinstance(response, dict) else None
    if not alternatives:
        return None
    text = alternatives[0].get("transcript", "").strip()
    if not text:
        return None
    # Confidence is occasionally omitted; treat that as an average result.
    confidence = alternatives[0].get("confidence", 0.6)
    return {"text": text, "language": language, "score": confidence + 0.5 * stopword_ratio(language, text)}


def pick_best(results):
    """Highest score wins; earlier languages (the caller's preference) win ties."""
    best = None
    for result in results:
        if result and (best is None or result["score"] > best["score"]):
            best = result
    return best


class GoogleEngine:
    """Google's free web recognizer through SpeechRecognition. It needs the internet."""

    name = "google"
    device = "online"

    def load(self):
        try:
            import speech_recognition
        except ImportError:
            raise EngineError("O pacote Python SpeechRecognition não está instalado.", "package_missing")
        self.sr = speech_recognition

    def recognize(self, recognizer, audio_data, languages):
        sr = self.sr
        if len(languages) == 1:
            return {"text": recognizer.recognize_google(audio_data, language=languages[0]), "language": languages[0]}

        def attempt(language):
            try:
                return score(language, recognizer.recognize_google(audio_data, language=language, show_all=True))
            except sr.UnknownValueError:
                return None

        # Same latency as a single request: the languages are recognized concurrently.
        with ThreadPoolExecutor(max_workers=len(languages)) as pool:
            best = pick_best(list(pool.map(attempt, languages)))
        if not best:
            raise sr.UnknownValueError()
        return {"text": best["text"], "language": best["language"]}

    def transcribe(self, wav_path, languages):
        sr = self.sr
        recognizer = sr.Recognizer()
        recognizer.operation_timeout = 15
        try:
            with sr.AudioFile(wav_path) as source:
                audio_data = recognizer.record(source)
            return self.recognize(recognizer, audio_data, languages)
        except sr.UnknownValueError:
            raise Unrecognized()
        except sr.RequestError as e:
            return {"error": f"Erro no serviço de reconhecimento: {str(e)}"}
        except TimeoutError:
            return {"error": "A transcrição demorou demais. Verifique a conexão e tente novamente"}


def prepare_wav(input_file):
    """The request's audio as a 16 kHz mono PCM16 WAV: the file itself when it already
    is one (PC capture packets), else a converted copy that the caller removes."""
    try:
        with wave.open(input_file, "rb") as source:
            if source.getframerate() == 16000 and source.getnchannels() == 1 and source.getsampwidth() == 2:
                return input_file
    except (wave.Error, EOFError):
        pass
    # Convert any format (webm, ogg, mp4, etc.) to 16kHz mono wav using ffmpeg
    wav_file = input_file + ".converted.wav"
    result = subprocess.run(["ffmpeg", "-y", "-i", input_file, "-ar", "16000", "-ac", "1", wav_file],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    if result.returncode != 0:
        raise EngineError("Falha ao converter áudio com ffmpeg", "convert_failed")
    return wav_file


def transcribe_audio(engine, input_file, language="pt-BR"):
    # A comma-separated list ("pt-BR,en-US") detects which language was spoken.
    languages = [item.strip() for item in language.split(",") if item.strip()] or ["pt-BR"]
    wav_file = None
    try:
        wav_file = prepare_wav(input_file)
        return engine.transcribe(wav_file, languages)
    except Unrecognized:
        return {"error": "Não foi possível entender o áudio", "code": "unrecognized"}
    except EngineError as e:
        return {"error": str(e), "code": e.code}
    except subprocess.TimeoutExpired:
        return {"error": "A conversão do áudio demorou demais", "code": "convert_failed"}
    except Exception as e:
        # A local engine that throws is treated as broken for this request: the app retries with Google.
        return {"error": str(e), "code": "engine_error" if engine.name != "google" else None}
    finally:
        if wav_file and wav_file != input_file and os.path.exists(wav_file):
            try:
                os.remove(wav_file)
            except OSError:
                pass


def serve(config):
    """One long-lived process for every request: no interpreter start-up per chunk.

    Writes {"event": "ready", "engine", "device", "loadMs"} once the model is loaded,
    or {"event": "fatal", "error", "code"} and exits when it cannot load. Then reads
    one JSON request per line, {"id", "file", "language"}, and answers each with one
    JSON line carrying the same id. {"cancel": id} drops a request still waiting in
    a local engine's queue. Stdin closing ends the worker after the queued requests.
    """
    lock = threading.Lock()

    def write(message):
        line = json.dumps(message, ensure_ascii=False)
        with lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    name = config.get("engine") or "google"
    started = time.time()
    try:
        if name == "google":
            engine = GoogleEngine()
            engine.load()
        else:
            engine = create_engine(config)
    except EngineError as e:
        write({"event": "fatal", "error": str(e), "code": e.code})
        sys.exit(3)
    except Exception as e:
        write({"event": "fatal", "error": f"{type(e).__name__}: {e}", "code": "engine_error"})
        sys.exit(3)
    write({"event": "ready", "engine": name, "device": getattr(engine, "device", None),
           "loadMs": round((time.time() - started) * 1000)})

    def answer(request):
        try:
            result = transcribe_audio(engine, request["file"], request.get("language") or "pt-BR")
        except Exception as e:
            result = {"error": str(e)}
        write({"id": request.get("id"), **{key: value for key, value in result.items() if value is not None}})

    if name == "google":
        with ThreadPoolExecutor(max_workers=8) as pool:
            for request in requests():
                if "cancel" not in request:
                    pool.submit(answer, request)
        return

    # Local engines: one request at a time, in arrival order.
    pending = queue.Queue()
    cancelled = set()

    def run():
        while True:
            request = pending.get()
            if request is None:
                return
            if request.get("id") in cancelled:
                cancelled.discard(request.get("id"))
                write({"id": request.get("id"), "error": "Transcrição cancelada", "code": "cancelled"})
                continue
            answer(request)

    runner = threading.Thread(target=run, daemon=True)
    runner.start()
    for request in requests():
        if "cancel" in request:
            cancelled.add(request["cancel"])
        else:
            pending.put(request)
    pending.put(None)
    runner.join()


def requests():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except ValueError:
            continue


def main():
    # A terminated worker still runs atexit handlers, which stop a whisper-server it started.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    args = sys.argv[1:]
    if args[:1] == ["--serve"]:
        config = {}
        if args[1:2] == ["--config"] and len(args) > 2:
            config = json.loads(args[2])
        serve(config)
        sys.exit(0)
    if not args:
        print(json.dumps({"error": "Nenhum arquivo de áudio fornecido"}))
        sys.exit(1)
    engine = GoogleEngine()
    engine.load()
    res = transcribe_audio(engine, args[0], args[1] if len(args) > 1 else "pt-BR")
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
