# Áudio e latência

Este documento descreve o fluxo atual. Com Antigravity ou um provedor por API key, o modo automático responde à fala enquanto ela acontece, como o Perssua: uma prévia aparece antes de a pergunta terminar e é substituída conforme o texto cresce. Codex, Claude Code e OpenCode respondem somente à transcrição consolidada.

## Da captura à resposta

1. O PC envia o primeiro segundo de fala ao reconhecimento e, depois, o trecho aberto a cada segundo (veja "Transcrição do PC"). O microfone continua usando janelas de aproximadamente 3 segundos, com 800 ms de sobreposição.
2. O texto parcial aparece na interface. Com Antigravity ou API key, um parcial com pelo menos 4 palavras inicia uma prévia no modo automático (veja "Prévias durante a fala").
3. Após 300 ms de pausa, o reconhecimento do trecho aberto começa. A fala continua aberta até completar 900 ms de silêncio.
4. Se o áudio voltar antes disso, os trechos continuam na mesma fala. Caso contrário, o app consolida a transcrição após concluir os pedidos de reconhecimento pendentes.
5. No modo automático, o agendador envia o texto consolidado ao copiloto, a menos que uma prévia já tenha respondido exatamente esse texto. O prompt inclui a persona, o contexto pessoal salvo e, se houver uma vault conectada, os trechos das notas encontrados para a fala.

A busca nas notas não chama o modelo nem uma ferramenta. Ela roda em memória, em poucos milissegundos, a cada transcrição parcial; o card aparece enquanto a pessoa ainda fala, e a fala consolidada só repete uma busca local antes do envio. Os trechos acrescentam até 2.000 caracteres ao prompt, e apenas quando há resultado.

O microfone finaliza ao soltar o push-to-talk ou parar a gravação e segue o fluxo de mensagem direta ao agente.

Os 900 ms são um critério de silêncio, não uma garantia de pergunta completa. Uma pausa longa pode dividir o enunciado. Áudio sem pausas é dividido após 30 s (45 s, no máximo, se não houver um ponto mais baixo). O botão **Diga isso** usa a última transcrição consolidada, sem recompor automaticamente uma pergunta dividida em vários trechos.

## Transcrição do PC

Por padrão, o reconhecimento é o gratuito do Google, via `server/transcribe.py`, sem custo nem API key (os motores locais estão em "Reconhecimento local"). Ele só aceita arquivos inteiros e demora mais quanto maior o áudio: medido em 16 de outubro de 2026, cerca de 0,5 s para 1 s de fala, 1,2 s para 4 s, 1,9 s para 8 s e 2,5 s para 13,5 s. Por isso a fala é tratada em trechos curtos (`shared/rolling-transcription.js`):

- O trecho aberto da fala é reenviado a cada segundo, enquanto cresce. Cada resposta substitui o texto anterior desse trecho; uma resposta atrasada nunca substitui uma mais nova.
- Quando o trecho passa de 3 s, ele é fechado numa pausa real, com 150 ms pelo menos 30 dB abaixo da fala, e enviado uma última vez inteiro. O texto desse trecho fica fixo, e o próximo trecho começa depois da pausa. Uma queda curta de volume costuma ser uma consoante, não uma pausa; cortar ali estraga a palavra dos dois lados. Sem pausa, o trecho cresce até 7 s e é cortado no ponto mais baixo.
- Os trechos não se sobrepõem, então não é preciso juntar transcrições por palavras repetidas, que era a fonte de erros como "cons consistência" nas janelas de 3 s.
- Após 300 ms de pausa, o trecho aberto é enviado com 300 ms do silêncio, para que a última sílaba baixa ("from it") não seja cortada. Se a fala não voltar, esse resultado vira a transcrição final.
- Um único processo `transcribe.py --serve` atende todos os pedidos, em paralelo e identificados por id, sem iniciar o Python a cada trecho. Ele é iniciado junto com a captura. Com um motor local, os pedidos são atendidos um de cada vez (veja "Reconhecimento local").
- Um trecho sem resposta não interrompe a fala, porque o próximo cobre o mesmo áudio. A fala só termina em erro se não houver texto nenhum. As transcrições finais saem na ordem em que as falas aconteceram.
- No modo automático de idioma, o idioma é decidido com pelo menos 1,5 s de fala; o primeiro segundo ("Como") não basta.

Os parciais chegam à tela a cada resposta. O copiloto recebe um parcial com 4 ou mais palavras no máximo a cada 2 s, exceto o parcial da pausa, enviado na hora. Cada parcial reinicia a prévia, e no Antigravity uma prévia cancelada custa um processo que leva cerca de 4 s para ser substituído.

Gravações de teste (voz sintética do Google, uma fala de 13,5 s em português e outra de 6 s em inglês), reconhecimento real, mesmo áudio nas duas versões:

| | Janelas de 3 s (antes) | Trechos de 1 s (agora) |
| --- | ---: | ---: |
| Primeiro parcial após o início da fala | 3,0 s | 1,5 a 1,7 s |
| Intervalo entre parciais | 1,9 a 2,4 s | cerca de 1,2 s |
| Final após o fim da fala, 6 s / 13,5 s | 1,9 s / 0,9 s | 1,0 a 1,1 s / 1,2 a 1,4 s |
| Transcrição final | com erros de junção ("Camisaria", "sonhos", "cons consistência", frase repetida) | igual ao reconhecimento do áudio inteiro |

A voz sintética tem menos pausas que a fala real; numa entrevista, os trechos tendem a ser fechados mais cedo. Cada segundo de fala gera cerca de um pedido ao serviço gratuito, contra um a cada 3 s antes. É um serviço não oficial; se ele passar a recusar pedidos, as falas terminam com erro de reconhecimento.

Para medir com uma gravação (qualquer formato que o ffmpeg leia):

```bash
node scripts/measure-transcription-latency.js gravacao.wav auto
```

O script passa a gravação pela captura real (detecção de voz, trechos, processo do Python e reconhecimento do Google) em ritmo real e mostra cada parcial, a transcrição final e os tempos.

## Reconhecimento local

Os motores locais (Parakeet, Whisper large-v3-turbo, Whisper small/base e Vosk; veja o [guia de uso](usage.md#reconhecimento-de-voz)) usam os mesmos trechos. O modelo é carregado uma vez, quando a captura começa, pelo mesmo processo `transcribe.py --serve`, que atende um pedido por vez: dois ao mesmo tempo só disputariam a CPU (ou a GPU). Por isso, com um motor local, cada fala mantém no máximo um pedido em andamento (`maxInFlight: 1` em `RollingTranscription`). Um trecho aberto que chega enquanto outro pedido está em andamento espera e é substituído pelo seguinte; quando há vez, só o áudio mais recente vai ao modelo. Os fechamentos de trecho e o pedido final nunca esperam nem são descartados. Um pedido ainda na fila do processo é descartado quando a fala é cancelada.

Assim, um motor mais lento que a fala não acumula atraso: o texto parcial só atualiza com menos frequência. O Whisper small, por exemplo, leva cerca de 2 s por pedido nesta máquina, e os parciais chegam a cada 2 s em vez de a cada segundo.

### Medições de 18 de outubro de 2026

Máquina: Intel i5-10400F (6 núcleos, 12 threads), 16 GB de RAM, AMD Radeon RX 6600 (Vulkan, driver RADV), Arch Linux, Python 3.14, sherpa-onnx 1.13.8, faster-whisper 1.2.1 (CTranslate2 4.8.3, int8), vosk 0.3.45, whisper.cpp (commit `0c7be69`) compilado com Vulkan. Áudio: 8 frases em pt-BR e 8 em inglês do conjunto de teste do [FLEURS](https://huggingface.co/datasets/google/fleurs) (CC BY 4.0; leitura de frases, de 4 a 19 s), idioma automático (`pt-BR,en-US`), um pedido por vez. A coluna de cada duração é a mediana do tempo de um pedido com o primeiro 1, 3, 5 ou 7 s de cada frase, que são os tamanhos que a captura envia. O WER é a taxa de erro de palavras da frase inteira contra o texto de referência, ignorando maiúsculas e pontuação.

| Motor | Onde | Carga | RAM | 1 s | 3 s | 5 s | 7 s | WER pt-BR | WER inglês |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Google | online | — | 37 MB | 0,49 s | 1,01 s | 1,47 s | 1,82 s | 14% | 8% |
| Parakeet TDT 0.6B v3 int8 | CPU | 1,8 s | 1.245 MB | 0,13 s | 0,24 s | 0,33 s | 0,40 s | 6% | 6% |
| Whisper large-v3-turbo q5_0 | GPU | 0,5 s | 243 MB + GPU | 1,19 s | 1,21 s | 1,22 s | 1,25 s | 6% | 5% |
| Whisper small int8 | CPU | 0,9 s | 1.190 MB | 2,15 s | 2,03 s | 2,05 s | 2,08 s | 10% | 6% |
| Whisper base int8 | CPU | 0,7 s | 725 MB | 0,63 s | 0,67 s | 0,70 s | 0,70 s | 22% | 10% |
| Vosk small (pt + en) | CPU | 0,6 s | 398 MB | 0,64 s | 1,51 s | 2,20 s | 3,14 s | 40% | 20% |

- A carga é o tempo até o processo avisar que o modelo está pronto, com os arquivos já no cache do sistema; na primeira vez depois de ligar o computador ela é maior. A RAM é a memória residente do processo (e do `whisper-server`) depois das 80 transcrições; a memória da placa de vídeo não foi medida.
- O Whisper processa uma janela fixa de 30 s, então o tempo quase não muda com o tamanho do trecho. O Parakeet e o Vosk crescem com o áudio. No modo automático, o Vosk transcreve com os dois modelos, por isso fica mais lento que com o idioma fixo (não medido separadamente).
- Todos acertaram o idioma das 16 frases, menos o Vosk, que errou 1 (uma frase em português transcrita como inglês).
- O Whisper large-v3-turbo só na CPU (`-ng`) não foi medido.
- São 16 frases lidas, com boa gravação; numa reunião real, com várias pessoas, ruído e fala espontânea, os erros tendem a ser maiores para todos. O WER ignora a pontuação, então a falta dela no Google não conta como erro.

Com a captura real em ritmo real (`measure-transcription-latency.js`, uma frase de 19,3 s em pt-BR, idioma automático), os parciais chegaram em média a cada 0,84 s com o Google, 0,87 s com o Parakeet, 0,89 s com o Whisper large-v3-turbo e 1,2 s com o Whisper small, que teve 11 parciais contra 16 a 17 dos outros. O primeiro parcial apareceu 2,3 s (Parakeet), 2,8 s (Google), 3,4 s (large-v3-turbo) e 4,3 s (small) após o início do áudio. A transcrição final saiu 0,6 a 1,1 s antes no Parakeet que nos outros.

Para repetir com outras gravações, veja o [guia de desenvolvimento](development.md#verificação).

## Controle da espera

O microfone ainda usa janelas de 3 s, processadas em ordem e com fila limitada. Quando uma janela curta não é reconhecida, ela é ampliada com as vizinhas, até 10 s de contexto.

O copiloto mantém uma geração automática por vez. Se o modelo ficar para trás, a fala completa mais recente substitui respostas antigas ainda pendentes. As transcrições permanecem no histórico; encher a fila não reinicia o agente ativo.

Antigravity, Codex e Claude Code preparam e reutilizam sessões de processo. A preparação não envia uma pergunta. Cancelar uma resposta ou um erro durante a geração encerra o processo; o app inicia o substituto em seguida, com a mesma conversa, para que a próxima pergunta não espere o CLI iniciar. Reset e mudança de configuração preparam uma nova sessão.

Os CLIs rodam numa pasta vazia (`interviewai-agent` no diretório temporário do sistema), fora do projeto, para não carregar repositório, AGENTS.md ou CLAUDE.md. O Claude Code roda sem ferramentas, servidores MCP, plugins e skills, e o Claude Code e o Codex usam um system prompt curto no lugar do prompt de agente de código. O Antigravity desativa a expansão de comandos e skills; ele mantém as ferramentas, pois abre as capturas de tela como arquivos.

## Prévias durante a fala

No Perssua, a sugestão já está na tela quando o interlocutor termina a pergunta: a geração começa com a transcrição parcial e é refeita conforme a fala continua. O app segue o mesmo modelo quando cancelar uma geração é barato:

- Cada parcial maior inicia uma prévia com o mesmo prompt da resposta final e cancela a prévia anterior da mesma fala. O texto antigo continua visível até a nova chegar.
- Se a transcrição consolidada for igual ao texto da prévia, a prévia vira a resposta, sem nova geração. Isso é comum: o parcial gerado após 300 ms de pausa costuma ser o texto final.
- Se a transcrição final for diferente, a prévia é cancelada e a resposta final começa na hora. Uma resposta final nunca é cancelada por uma prévia da fala seguinte.
- Essas respostas rodam fora da conversa do CLI, como turnos avulsos; o prompt já leva as falas recentes. No Antigravity, o app mantém dois processos já iniciados para esses turnos, e uma prévia cancelada custa um processo, não uma inicialização de cerca de 4 s antes da próxima resposta. Mensagens diretas recebem as falas e sugestões feitas desde a mensagem anterior, que a conversa do CLI não viu.

Codex, Claude Code e OpenCode continuam respondendo somente à fala consolidada: lá, cancelar significa reiniciar o processo, e a pergunta completa esperaria a prévia descartada.

As prévias aumentam o número de pedidos ao provedor, em geral de dois a quatro por pergunta longa.

## Medir o provedor

Encerre o desktop para evitar chamadas concorrentes e execute um dos comandos:

```bash
AGY_BIN="$(command -v agy)" node scripts/measure-response-latency.js

CODEX_BIN="$(command -v codex)" LATENCY_PROVIDER=codex node scripts/measure-response-latency.js
```

O script usa duas chamadas por padrão. `LATENCY_RUNS` altera a quantidade; `LATENCY_MODEL` seleciona outro modelo. Os padrões atuais do script são `gemini-3.8-flash` para Antigravity e `gpt-5.6-luna` para Codex, com raciocínio `low` e Fast Mode habilitado nas opções. A disponibilidade depende da conta.

A saída contém tempo de preparação, tempo até o primeiro texto (`firstTextMs`), duração total (`totalMs`), contagens de eventos e caracteres. O processo retorna código 1 se uma resposta não produzir texto ou se o primeiro texto ultrapassar 3 segundos. Esse limite é um critério de diagnóstico, não um compromisso de desempenho.

O script ainda monta um prompt com `isPreview: true`, para respostas curtas. Portanto, mede geração com esse prompt específico, não reproduz integralmente o modo automático atual. Também não inclui captura, transcrição ou detecção de silêncio. Ele usa o provedor real e consome a cota da conta autenticada.

## Medições de 16 de outubro de 2026

Antigravity / Gemini 3.8 Flash, raciocínio `low`, medido com o CLI real:

| Cenário | Primeiro texto |
| --- | ---: |
| Prompt de uma palavra ("ok"), processo já iniciado | 2.139 a 3.029 ms |
| Prompt completo do copiloto (cerca de 3.700 tokens), mesma conversa, 6 perguntas | 2.167 a 3.824 ms |
| Prompt completo, processo novo já iniciado | 2.500 a 3.380 ms |
| Inicialização do processo | 3.569 a 4.870 ms |

O tamanho do prompt e o histórico da conversa quase não mudam o tempo: o piso de 2 a 3 s é do próprio CLI. Numa simulação de pergunta falada em 7 s, a prévia apareceu 5,9 s após o início da fala (antes, 10,3 s); a resposta à pergunta completa começou 3,0 a 3,2 s após o fim da fala (antes, 3,3 s). Abaixo disso, só um provedor com menor tempo até o primeiro token, como a API do Gemini com API key.

## Medições históricas

Amostras registradas em 9 de outubro de 2026, preservadas como referência. Não foram repetidas após as alterações de contexto pessoal e estilo dos prompts.

| Provedor/modelo | Primeiro pedido: primeiro texto | Segundo pedido: primeiro texto |
| --- | ---: | ---: |
| Antigravity / Gemini 3.8 Flash | 3.284 ms | 2.219 ms |
| Codex / GPT-5.6 Luna | 3.311 ms | 1.436 ms |

São amostras pequenas, medidas a partir do envio do prompt. Outros pedidos do Antigravity pelo endpoint do app tiveram primeiro texto em 2.353 e 9.912 ms. Essa variação impede afirmar uma latência estável ou comparar os provedores apenas por essa tabela.

Um teste com relógio controlado e reconhecimento simulado de 400 ms verifica que a transcrição pode ficar pronta ao terminar a pausa de 900 ms, pois o reconhecimento começa durante o silêncio. Isso valida a sobreposição das etapas; não mede a rede nem o modelo real.

## Diagnóstico

| Sintoma | O que verificar |
| --- | --- |
| Nenhuma transcrição do PC | Estado da captura, saída padrão de áudio, pactl e parec. Com um aplicativo escolhido como fonte, confira se ele está tocando áudio ("aguardando" em âmbar nos medidores) ou se o aviso do topo pede para escolher entre vários áudios; ou volte para "Desktop inteiro". |
| App não conecta ao backend (401 ou WebSocket recusado) | Backend antigo reaproveitado na porta 3001, sem o token desta execução; encerre-o e abra o app de novo. |
| Erro ou demora no reconhecimento | Python com SpeechRecognition, acesso à internet, volume e ruído do áudio. Mensagens `[Transcriber]` no log do backend. |
| Transcrição termina no meio da pergunta | Pausas de 900 ms ou falha de reconhecimento; compare o texto com o áudio ouvido. |
| Texto pronto, mas resposta demora | Preparação do CLI, pedidos anteriores e tempo de geração do modelo. |
| Resposta genérica ou sem fatos pessoais | Contexto salvo e persona selecionada; mensagens diretas não anexam o contexto do copiloto. |
| Mudança de backend não aparece | Processo antigo reaproveitado na porta 3001; reinicie esse backend. |

Os testes relevantes estão em `server/response-latency.test.js`, `server/live-copilot.test.js`, `server/pc-live-integration.test.js`, `server/pc-speech.test.js`, `server/transcriber.test.js`, `shared/rolling-transcription.test.js` e `shared/streaming-transcription.test.js`. Execute-os pela suíte `npm test` ou individualmente com `node --test`.
