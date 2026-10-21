import { useState, useEffect, useRef, useCallback } from 'react';
import { recordingToWav, startMicrophoneTranscription } from '../audio/microphone-transcription.js';
import { AUTO_LANGUAGE, createUtteranceLanguage } from '../../shared/language.js';
import { apiFetch } from '../backend.js';

const VISUALIZER_FRAME_MS = 50;

function stopRecognitionAndWait(recognition, timeoutMs = 800) {
  if (!recognition) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve();
    };
    timeoutId = setTimeout(finish, timeoutMs);

    recognition.onend = finish;
    try {
      recognition.stop();
    } catch {
      finish();
    }
  });
}

/**
 * Unified Voice Copilot Hook
 * Combines:
 * 1. Web Audio API (live decibels & waveform frequencies)
 * 2. MediaRecorder (high-fidelity audio recording across ALL browsers)
 * 3. Web Speech API (instant interim preview if available)
 * 4. Incremental PCM transcription during capture, with full-recording fallback
 * 5. Spacebar Push-To-Talk
 */
export function useVoiceCopilot({
  language = AUTO_LANGUAGE,
  onFinalTranscript,
  enabled = true,
}) {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [frequencyBars, setFrequencyBars] = useState(() => Array(48).fill(12));
  const [micPermission, setMicPermission] = useState('prompt'); // 'prompt' | 'granted' | 'denied'
  const [errorMessage, setErrorMessage] = useState(null);
  const [isPushToTalkActive, setIsPushToTalkActive] = useState(false);
  const [detectedLanguage, setDetectedLanguage] = useState(null);

  // Audio refs
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const animationFrameRef = useRef(null);

  // Speech Recognition refs
  const recognitionRef = useRef(null);
  const speechRecognizedTextRef = useRef('');
  const isListeningRef = useRef(false);
  const startingRef = useRef(false);
  const recordingGenerationRef = useRef(0);
  const microphoneTranscriptionRef = useRef(null);
  const finishingTranscriptionRef = useRef(null);
  const fallbackControllerRef = useRef(null);
  const mountedRef = useRef(true);
  const onFinalTranscriptRef = useRef(onFinalTranscript);
  // Last language heard in auto mode: preferred on ties and used by Web Speech,
  // which cannot detect the language itself.
  const lastLanguageRef = useRef(null);
  const rememberLanguage = useCallback((detected) => {
    if (!detected) return;
    lastLanguageRef.current = detected;
    setDetectedLanguage(detected);
  }, []);

  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  // Initialize Microphone & Web Audio Analyzer
  const getOrCreateStream = useCallback(async () => {
    if (mediaStreamRef.current && mediaStreamRef.current.active) {
      return mediaStreamRef.current;
    }

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Dispositivo de áudio não disponível para captura.');
      }

      console.log('[VoiceCopilot] Requesting microphone permission...');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      mediaStreamRef.current = stream;
      setMicPermission('granted');
      setErrorMessage(null);

      // Setup AudioContext & Analyser
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      return stream;
    } catch (err) {
      console.error('[VoiceCopilot] Mic permission error:', err);
      setMicPermission('denied');
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setErrorMessage('Permissão do microfone negada nas configurações do sistema.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setErrorMessage('Nenhum microfone encontrado conectado ao computador.');
      } else {
        setErrorMessage(`Erro ao acessar microfone: ${err.message}`);
      }
      return null;
    }
  }, []);

  // Web Audio visualizer animation loop
  const startVisualizer = useCallback(() => {
    let active = true;
    let dataArray = null;
    let lastFrame = 0;
    const updateVisualizer = () => {
      if (!active || !isListeningRef.current) return;
      animationFrameRef.current = requestAnimationFrame(updateVisualizer);
      // Each update re-renders the window: 20 per second is smooth enough for the meters.
      const now = Date.now();
      if (now - lastFrame < VISUALIZER_FRAME_MS) return;
      lastFrame = now;

      if (analyserRef.current) {
        const bufferLength = analyserRef.current.frequencyBinCount;
        if (dataArray?.length !== bufferLength) dataArray = new Uint8Array(bufferLength);
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avg = sum / bufferLength;
        const normalized = Math.min(100, Math.round((avg / 128) * 100));
        setAudioLevel(normalized);

        const barsCount = 48;
        const step = Math.max(1, Math.floor(bufferLength / barsCount));
        const newBars = [];

        for (let i = 0; i < barsCount; i++) {
          const rawVal = dataArray[(i * step) % bufferLength] || 0;
          const heightPercent = Math.max(12, Math.min(96, (rawVal / 255) * 100));
          newBars.push(heightPercent);
        }
        setFrequencyBars(newBars);
      } else {
        // Fallback pulsing animation
        const time = Date.now() / 150;
        const bars = Array.from({ length: 48 }, (_, i) => {
          const val = Math.sin(time + i * 0.28) * 35 + 40;
          return Math.max(15, Math.min(90, val));
        });
        setFrequencyBars(bars);
        setAudioLevel(40);
      }
    };

    updateVisualizer();

    return () => {
      active = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Start recording
  const startRecording = useCallback(async () => {
    if (isListeningRef.current || startingRef.current) return;
    startingRef.current = true;
    const generation = ++recordingGenerationRef.current;
    microphoneTranscriptionRef.current?.cancel();
    finishingTranscriptionRef.current?.cancel();
    finishingTranscriptionRef.current = null;
    fallbackControllerRef.current?.abort();
    if (recognitionRef.current) {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      try { recognition.abort(); } catch {}
    }
    mediaRecorderRef.current = null;
    microphoneTranscriptionRef.current = null;
    setIsTranscribing(false);
    setErrorMessage(null);
    speechRecognizedTextRef.current = '';
    setInterimTranscript('');
    recordedChunksRef.current = [];

    const stream = await getOrCreateStream();
    if (generation !== recordingGenerationRef.current || !mountedRef.current) {
      startingRef.current = false;
      return;
    }
    if (!stream) {
      startingRef.current = false;
      console.warn('[VoiceCopilot] Could not start recording without audio stream');
      return;
    }

    if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    if (generation !== recordingGenerationRef.current || !mountedRef.current) {
      startingRef.current = false;
      return;
    }
    startingRef.current = false;
    isListeningRef.current = true;
    setIsListening(true);
    startVisualizer();

    // Start PCM transcription independently of the backup recorder. Capturing
    // generation prevents late worklet setup/results from leaking into a new turn.
    startMicrophoneTranscription(audioContextRef.current, stream, {
      language,
      preferredLanguage: lastLanguageRef.current,
      onPartial: (text) => {
        if (mountedRef.current && generation === recordingGenerationRef.current) setInterimTranscript(text);
      },
    }).then((session) => {
      if (!isListeningRef.current || generation !== recordingGenerationRef.current || !mountedRef.current) session.cancel();
      else microphoneTranscriptionRef.current = session;
    }).catch((error) => console.warn('[VoiceCopilot] PCM capture unavailable; using fallback:', error.message));

    // 1. Start MediaRecorder
    const chunks = recordedChunksRef.current;
    try {
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg')
        ? 'audio/ogg'
        : '';

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.start(100);
      console.log('[VoiceCopilot] MediaRecorder started with mime:', recorder.mimeType);
    } catch (e) {
      console.warn('[VoiceCopilot] MediaRecorder error:', e);
    }

    // 2. Start Web Speech API if supported for live interim preview
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      try {
        if (recognitionRef.current) {
          const previousRecognition = recognitionRef.current;
          recognitionRef.current = null;
          try { previousRecognition.abort(); } catch {}
        }

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = language === AUTO_LANGUAGE ? lastLanguageRef.current || 'pt-BR' : language;

        recognition.onresult = (event) => {
          if (recognitionRef.current !== recognition) return;

          let interim = '';
          let final = '';

          for (let i = event.resultIndex; i < event.results.length; i++) {
            const part = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              final += part;
            } else {
              interim += part;
            }
          }

          if (interim && !microphoneTranscriptionRef.current) setInterimTranscript(`${speechRecognizedTextRef.current} ${interim}`.trim());
          if (final) {
            speechRecognizedTextRef.current += ' ' + final;
            if (!microphoneTranscriptionRef.current) setInterimTranscript(speechRecognizedTextRef.current.trim());
          }
        };

        recognition.onerror = (event) => {
          console.warn('[VoiceCopilot] SpeechRecognition event error:', event.error);
        };

        recognitionRef.current = recognition;
        recognition.start();
      } catch (err) {
        recognitionRef.current = null;
        console.warn('[VoiceCopilot] Could not start browser SpeechRecognition:', err);
      }
    }
  }, [getOrCreateStream, startVisualizer, language]);

  // Stop recording and process transcript
  const stopRecording = useCallback(async () => {
    if (!isListeningRef.current) {
      if (startingRef.current) ++recordingGenerationRef.current;
      return;
    }
    const generation = recordingGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === recordingGenerationRef.current;
    const chunks = recordedChunksRef.current;
    const pcmSession = microphoneTranscriptionRef.current;
    finishingTranscriptionRef.current = pcmSession;
    microphoneTranscriptionRef.current = null;
    const incrementalResult = pcmSession ? pcmSession.finish() : Promise.resolve(null);
    if (pcmSession) setIsTranscribing(true);
    isListeningRef.current = false;
    setIsListening(false);
    setAudioLevel(0);
    setFrequencyBars(Array(48).fill(12));

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    // Give Web Speech a moment to deliver its final result after stop().
    const recognition = recognitionRef.current;
    const recognitionFinalization = stopRecognitionAndWait(recognition);

    // Stop MediaRecorder and handle audio blob
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = async () => {
        const [streamed] = await Promise.all([incrementalResult, recognitionFinalization]);
        if (!isCurrent()) return;
        finishingTranscriptionRef.current = null;
        setIsTranscribing(false);
        if (recognitionRef.current === recognition) recognitionRef.current = null;
        if (streamed?.text) {
          rememberLanguage(streamed.language);
          onFinalTranscriptRef.current?.(streamed.text);
          setInterimTranscript('');
          speechRecognizedTextRef.current = '';
          return;
        }

        const browserText = speechRecognizedTextRef.current.trim();

        // If Web Speech API captured text successfully, use it!
        if (browserText) {
          console.log('[VoiceCopilot] Using browser Web Speech transcript:', browserText);
          onFinalTranscriptRef.current?.(browserText);
          setInterimTranscript('');
          speechRecognizedTextRef.current = '';
          return;
        }

        // Otherwise, send recorded audio blob to backend /api/transcribe
        if (chunks.length > 0) {
          try {
            setIsTranscribing(true);
            setInterimTranscript('Transcrevendo áudio com o servidor...');

            const blob = new Blob(chunks, {
              type: recorder.mimeType || 'audio/webm',
            });

            console.log(`[VoiceCopilot] Sending audio blob (${blob.size} bytes) to /api/transcribe...`);

            const controller = new AbortController();
            fallbackControllerRef.current = controller;
            const lang = createUtteranceLanguage(language, lastLanguageRef.current).request;
            // A WAV works with every recognizer; the original format needs ffmpeg in the backend.
            const wav = await recordingToWav(blob).catch((error) => {
              console.warn('[VoiceCopilot] Could not decode the recording; sending it as recorded:', error);
              return null;
            });
            const res = await apiFetch(`/api/transcribe?lang=${encodeURIComponent(lang)}`, {
              method: 'POST',
              headers: {
                'Content-Type': wav ? 'audio/wav' : blob.type || 'audio/webm',
              },
              body: wav || blob,
              signal: controller.signal,
            });

            const data = await res.json();
            if (!isCurrent()) return;
            setIsTranscribing(false);
            setInterimTranscript('');

            if (data.text?.trim()) {
              console.log('[VoiceCopilot] Server transcribed:', data.text);
              if (language === AUTO_LANGUAGE) rememberLanguage(data.language);
              onFinalTranscriptRef.current?.(data.text.trim());
            } else if (data.error) {
              console.warn('[VoiceCopilot] Transcribe error:', data.error);
              setErrorMessage(`Transcrição: ${data.error}`);
              setTimeout(() => setErrorMessage(null), 4000);
            }
          } catch (err) {
            if (!isCurrent()) return;
            console.error('[VoiceCopilot] Server transcribe fetch error:', err);
            setIsTranscribing(false);
            setInterimTranscript('');
            setErrorMessage('Não foi possível transcrever o áudio gravado.');
            setTimeout(() => setErrorMessage(null), 4000);
          }
        }
      };

      try {
        recorder.stop();
      } catch (e) {
        console.error('Error stopping recorder:', e);
      }
    } else {
      // Fallback if the recorder was not active. Interim hypotheses are never
      // submitted as final speech.
      const [streamed] = await Promise.all([incrementalResult, recognitionFinalization]);
      if (!isCurrent()) return;
      finishingTranscriptionRef.current = null;
      setIsTranscribing(false);
      if (recognitionRef.current === recognition) recognitionRef.current = null;

      const text = streamed?.text || speechRecognizedTextRef.current.trim();
      if (streamed?.text) rememberLanguage(streamed.language);
      if (text) {
        onFinalTranscriptRef.current?.(text);
        setInterimTranscript('');
        speechRecognizedTextRef.current = '';
      }
    }
  }, [language, rememberLanguage]);

  const cancelRecording = useCallback(() => {
    ++recordingGenerationRef.current;
    isListeningRef.current = false;
    microphoneTranscriptionRef.current?.cancel();
    finishingTranscriptionRef.current?.cancel();
    microphoneTranscriptionRef.current = null;
    finishingTranscriptionRef.current = null;
    fallbackControllerRef.current?.abort();
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    try { recognition?.abort(); } catch {}
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === 'recording') recorder.stop();
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    setIsListening(false);
    setIsTranscribing(false);
    setInterimTranscript('');
    setAudioLevel(0);
    setFrequencyBars(Array(48).fill(12));
    setIsPushToTalkActive(false);
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isListening, startRecording, stopRecording]);

  // Spacebar Push-to-Talk
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e) => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) {
        return;
      }

      // Alt+Space is the mic toggle shortcut, not push-to-talk.
      if (e.code === 'Space' && !e.altKey && !e.repeat && !isPushToTalkActive) {
        e.preventDefault();
        setIsPushToTalkActive(true);
        startRecording();
      }
    };

    const handleKeyUp = (e) => {
      if (e.code === 'Space' && isPushToTalkActive) {
        e.preventDefault();
        setIsPushToTalkActive(false);
        stopRecording();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [enabled, isPushToTalkActive, startRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ++recordingGenerationRef.current;
      isListeningRef.current = false;
      microphoneTranscriptionRef.current?.cancel();
      finishingTranscriptionRef.current?.cancel();
      fallbackControllerRef.current?.abort();
      recognitionRef.current?.abort();
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioContextRef.current) {
        try { audioContextRef.current.close(); } catch {}
      }
    };
  }, []);

  return {
    isListening,
    isTranscribing,
    interimTranscript,
    audioLevel,
    frequencyBars,
    micPermission,
    errorMessage,
    clearError: () => setErrorMessage(null),
    isPushToTalkActive,
    detectedLanguage,
    toggleListening,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
