# Desenvolvimento

## Ambiente

Use Node.js 22.12 ou superior, npm e Python 3. A captura de áudio do PC funciona no Linux (PipeWire/PulseAudio, com `pactl` e `parec`) e no Windows 10/11 (loopback do sistema capturado pelo Electron). macOS não é suportado.

### Linux

Em distribuições Debian/Ubuntu, as dependências de áudio podem ser instaladas com:

```bash
sudo apt install python3 python3-venv ffmpeg pulseaudio-utils
python3 -m venv .venv
source .venv/bin/activate
python -m pip install SpeechRecognition
npm ci
```

Inicie o app no mesmo terminal com o ambiente virtual ativo: o backend procura `python3` no `PATH`. O pacote `PyAudio` não é necessário para este fluxo, pois a captura acontece no Electron ou via `parec`, e o Python recebe arquivos de áudio.

Para ouvir só o aplicativo da reunião, o backend usa `pactl list sink-inputs`, `pactl subscribe` e `parec --monitor-stream`, todos do mesmo `pulseaudio-utils` (funcionam também com o `pipewire-pulse`). O `xdotool` é opcional: em sessões X11 ele fornece o título da janela de cada aplicativo na lista (`sudo apt install xdotool`). Sem ele, ou no Wayland, a lista mostra só o nome do aplicativo. Ao listar, o backend grava 600 ms de cada stream com `parec` para mostrar qual está com som.

### Windows

Instale o [Node.js](https://nodejs.org/) 22.12+ e o [Python 3](https://www.python.org/downloads/windows/) (marque “Add python.exe to PATH”). No PowerShell, na pasta do projeto:

```powershell
py -m pip install SpeechRecognition
npm ci
npm start
```

O `ffmpeg` é opcional no Windows: o app envia ao reconhecimento áudio WAV já em 16 kHz, e o `ffmpeg` só é usado para outros formatos. O backend procura o Python como `PYTHON_BIN`, `python`, `py -3` ou `python3`, ignorando o atalho da Microsoft Store.

No Windows, o backend não acessa o dispositivo de áudio: quando a captura do PC é ligada, a janela pede ao Electron o áudio do desktop (`chromeMediaSource: 'desktop'`), reduz para PCM 16 kHz mono num AudioWorklet e envia pacotes binários de 50 ms pelo WebSocket. O backend aplica a mesma detecção de fala e transcrição do Linux. Para testar esse caminho em outro sistema, defina `INTERVIEWAI_AUDIO_SOURCE=renderer` (o Electron só fornece o loopback no Windows).

Os CLIs instalados pelo npm no Windows são atalhos `.cmd`; o app os encontra pelo `PATH` (com `PATHEXT`) e os executa por meio do `cross-spawn`. Ao fechar, o Electron encerra a árvore de processos do backend com `taskkill`, incluindo os CLIs.

### Reconhecimento de voz local

O Google continua sendo o padrão e só precisa do `SpeechRecognition`. Os motores locais (veja [o guia de uso](usage.md#reconhecimento-de-voz)) precisam de um pacote Python cada, e o Whisper large-v3-turbo, do `whisper-server` do whisper.cpp. Os modelos são baixados pelo próprio app, em **Menu → Reconhecimento de voz**, para `models/` ao lado do perfil.

O backend usa, nesta ordem, o Python de `PYTHON_BIN`, o do ambiente virtual do app (`~/.local/share/interviewai/venv` no Linux, `%APPDATA%\InterviewAI\venv` no Windows) e o do sistema. Em distribuições que bloqueiam o `pip` no Python do sistema (Arch, Debian 12+, Ubuntu 23.04+), crie o ambiente do app com os pacotes que for usar:

```bash
python3 -m venv ~/.local/share/interviewai/venv
~/.local/share/interviewai/venv/bin/pip install SpeechRecognition sherpa-onnx faster-whisper vosk
```

A janela de reconhecimento mostra o comando exato para o Python que o app está usando, só com o que falta. No Linux, os quatro pacotes foram instalados e testados com Python 3.14; no Windows, a instalação não foi testada.

Para o Whisper large-v3-turbo na placa de vídeo, compile o whisper.cpp com Vulkan. No Linux, são necessários `cmake`, um compilador C++, os cabeçalhos do Vulkan e o `glslc` (no Arch: `vulkan-headers`, `shaderc` e o driver, como `vulkan-radeon`; no Ubuntu: `libvulkan-dev` e `glslc`):

```bash
git clone --depth 1 https://github.com/ggml-org/whisper.cpp ~/.cache/whisper.cpp
cd ~/.cache/whisper.cpp
cmake -B build -DGGML_VULKAN=1 -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build build -j --target whisper-server
mkdir -p ~/.local/share/interviewai/bin
cp build/bin/whisper-server ~/.local/share/interviewai/bin/
```

Com `BUILD_SHARED_LIBS=OFF` o executável não depende das bibliotecas da pasta de compilação. O app procura o `whisper-server` em `WHISPER_SERVER_BIN`, em `bin/` ao lado do perfil e no `PATH`. Ele inicia o servidor numa porta livre de `127.0.0.1`, com o modelo carregado uma vez; se a GPU falhar ao iniciar, tenta de novo com `-ng` (só CPU). Sem Vulkan, a compilação com `-DGGML_VULKAN=0` gera um servidor só de CPU, bem mais lento com esse modelo.

No Windows, baixe `whisper-bin-x64.zip` (CPU) da [página de releases](https://github.com/ggml-org/whisper.cpp/releases) e copie `whisper-server.exe` e as DLLs que vêm junto para `%APPDATA%\InterviewAI\bin\`. Para usar a GPU no Windows é preciso compilar com Vulkan (Vulkan SDK e Visual Studio); isso não foi testado neste projeto.

### Verificar

Instale e autentique o CLI do provedor escolhido antes de abrir o app. Para verificar as dependências locais:

```bash
node --version
python3 -c "import speech_recognition; print(speech_recognition.__version__)"
command -v ffmpeg pactl parec
command -v agy codex claude
```

## Executar e compilar

| Comando | Função |
| --- | --- |
| npm start | Inicia Vite, Electron e o backend local. |
| npm run dev | Mesmo fluxo de npm start, com atualização do frontend pelo Vite. |
| npm run build | Gera os arquivos do frontend em dist/. |
| npm run build:appimage | Compila o frontend e empacota o executável AppImage em release/. |
| npm run build:win | Compila o frontend e gera o instalador NSIS e o executável portátil do Windows (x64) em release/. |
| npm run pack | Empacota os binários do Electron descompactados em release/linux-unpacked. |
| npm run desktop | Abre o Electron; usa Vite se disponível, senão o frontend servido pelo backend. |
| npm test | Executa os testes offline de áudio, sessões, backend e interface. |

Para gerar e testar o AppImage independente:

```bash
npm run build:appimage
# ou:
./scripts/build-appimage.sh
```

Para o Windows, execute `npm run build:win` numa máquina Windows. Ele gera `release/InterviewAI-1.0.0-setup.exe` (instalador, permite escolher a pasta) e `release/InterviewAI-1.0.0-portable.exe` (sem instalação). No Linux, `npx electron-builder --win portable --x64` também gera o portátil; o instalador NSIS precisa do Wine com suporte a 32 bits para montar o desinstalador.

Os pacotes não incluem o Python nem os CLIs: instale-os na máquina de destino como descrito acima. O app não é assinado digitalmente, então o Windows SmartScreen pode pedir confirmação na primeira execução.

O AppImage gerado em `release/` inclui o frontend compilado, o backend Express/WebSocket e as dependências de produção para execução sem precisar do servidor de desenvolvimento ativo.

O Vite começa na porta 5173 e escolhe outra se ela estiver ocupada. O script passa a URL efetiva ao Electron. O backend escuta só em `127.0.0.1:3001` no fluxo desktop; se já houver um backend respondendo nessa porta, ele será reaproveitado (veja [Acesso ao backend](#acesso-ao-backend)). Um segundo backend que não consegue a porta encerra com erro antes de ler o histórico, para não assumir o rascunho da reunião do primeiro.

Mudanças no backend exigem reiniciar seu processo. Fechar o Electron encerra o backend que ele iniciou, mas não um backend reaproveitado. O Vite ignora alterações de backend, documentação e testes para evitar recargas da captura durante o desenvolvimento.

## Configuração por ambiente

| Variável | Uso |
| --- | --- |
| AGY_BIN | Caminho do executável Antigravity. Sem ela, o app procura `agy` no `PATH` e em `~/.local/bin`. |
| CODEX_BIN | Caminho do executável Codex. Sem ela, procura `codex` no `PATH`, em `/usr/bin` e, no Windows, em `%APPDATA%\npm`. |
| CLAUDE_BIN | Caminho do executável Claude Code. Sem ela, procura `claude` no `PATH`, em `~/.local/bin` e em `/usr/bin`. |
| PYTHON_BIN | Interpretador Python usado pelo transcritor; sem ela, o do ambiente virtual do app (`venv` ao lado do perfil), se existir, e depois `python3`/`python` (Linux) ou `python`/`py -3` (Windows). |
| WHISPER_SERVER_BIN | Caminho do `whisper-server` do whisper.cpp, para o motor Whisper large-v3-turbo; sem ela, `bin/whisper-server` ao lado do perfil e depois o `PATH`. |
| INTERVIEWAI_MODELS_DIR | Pasta dos modelos de reconhecimento baixados; padrão `models` ao lado do perfil. |
| INTERVIEWAI_AUDIO_SOURCE | `parec` (padrão no Linux) ou `renderer` (padrão no Windows): origem do áudio do PC. |
| PORT | Porta ao iniciar server/index.js diretamente; o launcher desktop fixa 3001. |
| INTERVIEWAI_NOTES_CONFIG | Arquivo onde fica a pasta da vault do Obsidian; padrão `notes.json` ao lado do perfil. |
| INTERVIEWAI_HISTORY_DIR | Pasta do histórico de reuniões; padrão `history` ao lado do perfil. |
| INTERVIEWAI_DEV_URL | URL do renderer; preenchida pelo script de desenvolvimento. O backend aceita pedidos dessa origem. |
| INTERVIEWAI_TOKEN | Token exigido pelo backend. O Electron gera um novo a cada execução e o passa ao backend que inicia; sem ela, o backend gera o próprio. |
| INTERVIEWAI_ALLOWED_ORIGINS | Origens extras, separadas por vírgula, que o navegador pode usar para chamar o backend (além de `http://127.0.0.1:3001`, `http://localhost:3001` e `INTERVIEWAI_DEV_URL`). |
| LATENCY_PROVIDER, LATENCY_MODEL, LATENCY_RUNS | Configuração do script de medição de latência. |

```bash
AGY_BIN="$(command -v agy)" CODEX_BIN="$(command -v codex)" npm start
```

```powershell
$env:CLAUDE_BIN = (Get-Command claude).Source; npm start
```

O backend não carrega `.env` automaticamente. Exporte as variáveis no shell ou passe-as no comando. O frontend e o Electron esperam a porta 3001; mudar apenas `PORT` não reconfigura todos os clientes.

## Organização do código

| Caminho | Responsabilidade |
| --- | --- |
| electron/ | Janela desktop, atalhos globais (Ctrl+Alt), captura de tela por monitor, permissões e ciclo de vida do backend. |
| scripts/dev.js | Inicialização do Vite e do Electron. |
| src/App.jsx | Composição da interface e sincronização de preferências. |
| src/components/ | Feed, controles, seletores e editor de contexto. |
| src/hooks/ | Estado do áudio, WebSocket e preferências locais, incluindo o zoom do texto (`useTextZoom`, salvo no `localStorage`). |
| src/audio/ | Captura PCM do microfone via AudioWorklet. |
| shared/streaming-transcription.js | Janelas WAV, sobreposição, fila e consolidação do texto. |
| server/index.js | API HTTP, WebSocket e coordenação da sessão. |
| server/system-audio-engine.js | Captura (parec no Linux, PCM recebido da janela no Windows), detecção de fala do PC e divisão de áudio contínuo (`maxSpeechMs`). Com `app`, grava só o stream de um aplicativo e o acompanha quando ele é recriado (eventos do `pactl subscribe`, mais uma verificação a cada 5 s). |
| server/audio-apps.js | Leitura do `pactl list sink-inputs`, lista dos streams (um por linha, com título da janela via `xdotool` e nível medido por uma amostra curta) e escolha do stream a gravar, sem adivinhar entre streams do mesmo programa (`pickStream`). |
| server/backend-auth.js | Token por execução, origens permitidas, CORS e verificação do WebSocket. |
| src/backend.js | `apiFetch` e URL do WebSocket com o token entregue pelo preload. |
| src/components/PcSourcePicker.jsx e src/hooks/usePcAudioSource.js | Seletor "Desktop inteiro" ou aplicativo nos medidores de áudio; a escolha fica no `localStorage`. |
| server/session-summary.js | Prompt do resumo (a primeira linha da resposta é `Título: …`), separação do título (`parseSummary`), atualização automática e Markdown da sessão. |
| server/meeting-history.js | Histórico de reuniões: um JSON por reunião, busca sem acento com pontuação por campo e trecho encontrado, e rascunho da reunião em andamento (`draft.json`) recuperado na próxima inicialização. |
| src/components/HistoryPanel.jsx e src/hooks/useMeetingHistory.js | Aba Histórico: busca, lista, detalhe, exclusão e novo resumo. |
| src/audio/system-loopback.js | Captura do loopback do sistema na janela do Electron (Windows) e envio do PCM pelo WebSocket. |
| server/cli-process.js | Localização dos CLIs e do Python (PATH/PATHEXT), execução de atalhos `.cmd` e encerramento da árvore de processos no Windows. |
| server/document-import.js | Extração de texto de PDF (`unpdf`), DOCX (`mammoth`), TXT e MD, prompt de organização e validação dos campos do currículo ou da vaga. |
| src/components/DocumentDropZone.jsx | Área de arrastar ou escolher arquivo das abas Perfil e Vaga. |
| server/pc-transcription.js | Encaminhamento dos trechos do PC ao transcritor. |
| server/transcriber.js | Um processo `transcribe.py --serve` por configuração de motor, ids dos pedidos, espera pelo modelo carregando, cancelamento, troca de motor (o processo antigo termina a fila e sai) e uso do Google quando o motor local não carrega ou falha. |
| server/transcribe.py e server/speech_engines.py | Processo de reconhecimento: Google (pedidos em paralelo) ou um motor local (modelo carregado uma vez, pedidos em fila); conversão do áudio e escolha do idioma de cada motor. |
| shared/speech-engines.js | Catálogo dos motores e modelos: descrições, pacotes, URLs e tamanhos. |
| server/speech-models.js | Download dos modelos (pasta `.partial`, extração com o próprio Python, marcador `.complete`), progresso, cancelamento e exclusão. |
| server/speech-settings.js | Motor escolhido (`speech.json` ao lado do perfil), Python e pacotes instalados, `whisper-server`, comando `pip` e configuração do processo. |
| src/components/SpeechEngineModal.jsx e src/hooks/useSpeechEngines.js | Menu → Reconhecimento de voz. |
| server/live-copilot.js | Agendamento de respostas: prévias durante a fala e resposta à fala consolidada. |
| server/gemini-copilot.js | Prompts das personas e despacho para ambos os provedores. |
| server/agent-bridge.js, server/codex-session.js e server/claude-session.js | Processos persistentes dos CLIs. |
| server/agent-images.js | Validação das imagens anexadas (até 4, base64 PNG/JPEG/WebP) e formato de cada CLI: inline no Codex e no Claude Code; arquivo temporário no Antigravity. |
| server/candidate-context.js | Leitura limitada ao contexto.md da raiz do projeto. |
| server/conversation-memory.js | Janela de falas reais, separada de sugestões da IA, enviada a cada pedido do copiloto. |
| server/notes-index.js | Índice BM25 em memória das notas: divisão por título, limpeza da sintaxe do Obsidian, termos sem acento e trechos com destaque. |
| server/notes-vault.js | Conexão da vault: leitura dos `.md`, observação de alterações (`fs.watch`), persistência da pasta e envio dos resultados por fala (`notes_hits`). |
| src/components/NotesCard.jsx e NotesVaultModal.jsx | Card dos trechos no feed e tela de configuração da vault. |
| shared/candidate-profile.js | Perfil estruturado: normalização, limites e montagem do texto enviado ao modelo. |
| server/profile-store.js | Persistência do perfil em `~/.local/share/interviewai/profile.json` ou `%APPDATA%\InterviewAI\profile.json` (gravação atômica). |

`POST /api/profile/import?kind=cv|job` recebe o arquivo no corpo (até 10 MB, nome no cabeçalho `X-File-Name`), organiza o texto com `runIsolatedAgent` (um processo do CLI só para esse pedido, sem afetar a sessão aquecida nem a conversa) e devolve `{ fields, warning? }`; nada é gravado até o usuário salvar. `GET /api/profile` e `PUT /api/profile` leem e gravam o perfil; o backend o carrega na inicialização e é a única fonte do contexto. `INTERVIEWAI_PROFILE_PATH` troca o arquivo (os testes usam um temporário). `GET /api/notes` devolve o estado da vault; `PUT /api/notes` (`{ path }`) conecta e indexa; `POST /api/notes/reindex` refaz o índice; `DELETE /api/notes` desconecta; `GET /api/notes/search?q=` mostra o que uma pergunta encontra. `GET /api/candidate-context/file` lê o `contexto.md` fixo do projeto, sem aceitar um caminho do cliente; a importação só altera o perfil quando o usuário salva.

`GET /api/history?q=` lista as reuniões (mais recentes primeiro, ou por relevância com busca); `GET /api/history/:id` devolve uma reunião com a transcrição; `POST /api/history/:id/summarize` gera de novo o resumo e o título; `DELETE /api/history/:id` apaga. Mudanças são avisadas pelo WebSocket com `history_changed`. Ao encerrar uma sessão, o backend reaproveita o resumo atual se ele cobre todas as falas; senão roda o resumo final com `runIsolatedAgent`, no modelo configurado para o resumo. A reunião em andamento é gravada em `draft.json` 2 s após cada fala e, no SIGTERM, na hora; na inicialização seguinte ela entra no histórico como pendente e é resumida 15 s depois de o servidor subir. `GET /api/audio-apps` lista os streams tocando (`{ supported, streams: [{ id, stream, name, media, window, playing, level, siblings }] }`; `supported: false` fora do `parec`). A captura de um deles é pedida com `start_pc_capture` e `options.app = { id, name, stream, media, fresh }`; `fresh` marca uma escolha feita na lista recém-listada. Sem ele (a escolha salva, ao abrir o app ou religar a captura), o índice só vale se o `media.name` próprio também bater, porque o PipeWire reaproveita índices. Os streams que tocavam ao lado do escolhido nunca o substituem quando ele termina (`pickStream` em `server/audio-apps.js`). O `pc_capture_status` traz `app.waiting` enquanto nada é gravado e `app.ambiguous` quando não dá para saber qual stream é o da chamada: nesse caso o backend não grava nenhum até o usuário escolher.

`GET /api/speech` devolve o motor escolhido, o que falta a cada um (`missingPackages`, `pip`, `binary`, `modelsReady`, `ready`), o estado dos modelos (`installed`, `bytes`, `download: { received, total, phase }`, `error`) e o motor em uso (`active: { engine, status, device, loadMs, error }`, com `status` `idle`, `loading`, `ready`, `failed` ou `fallback`); com `?refresh=1`, verifica os pacotes Python de novo. `PUT /api/speech` (`{ engine, variant }`) troca o motor e dá nova chance a um motor que falhou. `POST /api/speech/models/:id/download` inicia um download, `DELETE` no mesmo caminho o cancela, e `DELETE /api/speech/models/:id` apaga o modelo. O WebSocket envia `speech_status` a cada mudança (progresso a cada 250 ms) e `speech_fallback` uma vez quando um motor local é trocado pelo Google.

O processo `transcribe.py --serve --config '<json>'` escreve `{ "event": "ready", "engine", "device", "loadMs" }` quando o modelo carrega ou `{ "event": "fatal", "error", "code" }` e sai. Os pedidos continuam no formato `{ id, file, language }` → `{ id, text, language }` ou `{ id, error, code }`; `{ "cancel": id }` descarta um pedido ainda na fila de um motor local. Os códigos `engine_error`, `engine_unavailable`, `model_missing`, `package_missing`, `binary_missing` e `timeout` fazem o pedido ir ao Google; `unrecognized` (sem fala) não. Um modelo, pacote ou programa ausente deixa o motor de lado até a configuração mudar; um erro avulso só depois de 3 seguidos.

## Acesso ao backend

O backend escuta apenas em `127.0.0.1` e só atende a janela do app:

- Todo pedido em `/api` precisa do cabeçalho `X-InterviewAI-Token`, e o WebSocket, de `?token=`. A exceção é `GET /api/health`, que só responde `{ status: 'online' }` e serve para o Electron saber que o backend subiu.
- O Electron gera o token a cada execução (`INTERVIEWAI_TOKEN`) e o entrega à página pelo preload (`interviewaiDesktop.backendToken()`), apenas para páginas do próprio app. A janela não navega para outros sites: links abrem no navegador padrão.
- O backend grava o token em `backend-token` ao lado do perfil, com permissão `0600`, depois de conseguir a porta. É assim que um Electron que reaproveita um backend iniciado à mão (`node server/index.js`) obtém o token. Scripts locais como `server/test-client.js` também o leem dali.
- Pedidos com `Origin` de outro site recebem 403 antes de qualquer rota, e o CORS só libera as origens do app. Pedidos sem `Origin` (processos locais) passam a depender só do token.

Por isso, abrir `http://127.0.0.1:3001` num navegador comum mostra a interface sem conseguir usar o backend; use a janela do Electron.

## Verificação

```bash
npm test
npm run build
git diff --check
```

Os testes simulam CLIs, reconhecimento e captura quando necessário; não enviam perguntas a provedores reais. Há testes para o envio de imagens aos CLIs (`agent-bridge.test.js`, `agent-images.test.js`), para o zoom do texto (`useTextZoom.test.js`), para a importação de currículo e vaga (`document-import.test.js`, com um PDF gerado no teste), para execuções isoladas dos três CLIs, para a busca de CLIs no `PATH` do Windows (`cli-process.test.js`), para o áudio recebido da janela (`system-audio-engine.test.js`), para a captura de um stream com `pactl` e `parec` simulados (`audio-apps.test.js`), para o token, as origens, o bind em loopback e a recusa de um segundo backend (`backend-auth.test.js`) e para o histórico, a busca e a recuperação do rascunho (`meeting-history.test.js`; o fluxo completo de Nova sessão até o histórico fica em `session-summary-integration.test.js`). Eles abrem portas locais e criam processos filhos, então o ambiente precisa permitir essas operações. Há testes específicos para leitura de contexto, cancelamento, retomada de fala, fila de respostas e reutilização de sessões.

Os testes de sessão verificam que perguntas de continuidade recebem as falas anteriores, as mensagens do usuário e suas correções pelos dois provedores. Também verificam a limpeza em nova sessão, a ausência de sugestões geradas entre os fatos e a preservação de falas captadas no modo manual. Isso valida os dados enviados, não a qualidade semântica de um modelo real.

Para revisar respostas reais em seis cenários fictícios (técnico, hipótese, experiência conhecida, experiência ausente, continuidade e dado pessoal ausente), execute `npm run eval:copilot`. Esse comando usa a cota do provedor autenticado; não faz parte de `npm test`. Configure `EVAL_PROVIDER`, `EVAL_MODEL` e, opcionalmente, `EVAL_CASE`. O relatório JSON contém o texto das respostas para revisão humana. Verifique se a explicação é concreta, se hipóteses estão identificadas, se experiências e resultados foram preservados e se dados pessoais não foram inventados.

Para comparar os motores de reconhecimento no seu computador, com os modelos já baixados pelo app:

```bash
node scripts/benchmark-speech-engines.js --json resultado.json gravacao-pt.wav gravacao-en.wav
```

Ele carrega cada motor, mede o tempo de carga e a memória, transcreve o primeiro 1, 3, 5 e 7 s e o arquivo inteiro de cada gravação e mostra os textos lado a lado. Um `gravacao-pt.wav.txt` ao lado do áudio é o texto de referência, para a taxa de erro de palavras (WER); `pt` ou `en` no caminho decide o idioma da linha. Use `--engines parakeet,vosk` para escolher motores e `--language pt-BR` para fixar o idioma. O Google consome o serviço gratuito a cada pedido. Para ver o fluxo ao vivo com um motor local, `node scripts/measure-transcription-latency.js gravacao.wav auto parakeet`.

O script `scripts/measure-response-latency.js` é diferente da suíte offline: chama o provedor autenticado e consome sua cota. Veja [como medir](response-latency.md#medir-o-provedor).

## Arquivos locais

O `.gitignore` exclui `contexto.md`, `.env`, dependências, build, logs, ambientes virtuais, caches Python e relatórios de testes. Exemplos `.env.example` podem ser versionados, mas não são carregados automaticamente.

O backend é voltado ao uso local: escuta só em `127.0.0.1` e exige o token de cada execução ([Acesso ao backend](#acesso-ao-backend)). Outros processos do mesmo usuário podem ler o arquivo do token, como podem ler o resto dos dados do app. Não trate esse backend como um serviço pronto para hospedagem pública. O bridge do Antigravity inicia o CLI com `--dangerously-skip-permissions`; considere esse comportamento ao executar mensagens diretas no agente.
