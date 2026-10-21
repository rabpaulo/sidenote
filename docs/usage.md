# Guia de uso

## Preparar uma conversa

Na primeira abertura, se faltar algo, a tela **Bem-vindo ao Sidenote** mostra os dois passos: uma API key (Gemini e Groq têm plano gratuito; **Outros…** abre todas as chaves), um CLI autenticado (a tela diz quais encontrou instalados sem login) ou um [modelo local](#modelos-locais-ollama-e-lm-studio), e o download do Parakeet para o reconhecimento de voz. Cada passo já resolvido aparece marcado. A tela some depois de fechada; os mesmos ajustes ficam em **Menu → Chaves de API** e **Menu → Reconhecimento de voz**.

Abra o app com `npm start`. No menu (☰) da barra inferior, selecione em **Modelo** o provedor, o modelo e o nível de raciocínio, e em **Modo** a persona adequada: conversa geral, vendas, entrevista técnica, arquitetura, comportamental, RH, perguntas ao entrevistador ou vendas.

O app prepara a sessão do agente sem enviar uma pergunta. Ao abrir, o backend verifica cada provedor sem gastar cota: se o CLI está instalado e logado e, no Antigravity (`agy models`) e no Codex (`model/list`), quais modelos a conta oferece. O Claude Code informa só o login, então todos os modelos da lista ficam liberados quando ele está logado. O seletor não traz uma lista fixa: em **Encontrados neste computador** ficam só os provedores que o app achou na máquina (CLIs instalados, APIs com key salva ou em variável de ambiente, Ollama e LM Studio instalados). Os demais ficam recolhidos em **Outros provedores**, cada um com o que falta: **Não instalado** (CLI ausente), **Adicionar key** (abre as chaves de API) ou **Instalar**/**Iniciar**/**Baixar modelo** (abre os modelos locais). Um provedor encontrado mas indisponível, como um CLI sem login, continua na lista de cima, desativado e com o motivo. **Verificar novamente** refaz a busca, por exemplo depois de instalar um CLI ou fazer login.

Se o modelo salvo deixar de estar disponível, o app troca para o primeiro modelo utilizável, do mesmo provedor se houver, e avisa no topo da janela. Sem nenhuma opção utilizável, um aviso vermelho explica o motivo, e o backend recusa iniciar o agente, a sugestão automática e as mensagens diretas. Uma falha ao iniciar ou responder também dispara uma nova verificação daquele provedor. Para Antigravity, Codex e Claude Code, a lista do seletor continua definida no projeto: modelos novos da conta só aparecem depois de adicionados em `src/config/models.js`.

### OpenCode

Com o [OpenCode](https://opencode.ai) instalado (`opencode` no PATH, em `~/.opencode/bin` ou em `OPENCODE_BIN`), ele aparece entre os provedores com os modelos de `opencode models`, no formato `provedor/modelo`: os modelos próprios do OpenCode (inclusive os gratuitos) e os provedores configurados nele. O app mantém um `opencode serve` local aberto, protegido por senha, para que cada resposta não espere o CLI iniciar. Os modelos `opencode/…` só aceitam o agente padrão do OpenCode, então usam o prompt de programação dele; os demais provedores recebem um agente só de texto, sem ferramentas, com o prompt curto do copiloto. As conversas ficam salvas no histórico do OpenCode.

### Chaves de API

Em **Menu → Chaves de API** (ou **Gerenciar keys** no seletor de modelo), cole a key de OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, DeepSeek, Mistral ou xAI. O backend valida a key listando os modelos da conta, sem gastar tokens, e o provedor passa a aparecer em **Modelo** com esses modelos; uma key recusada aparece como **Inválida**. Para um modelo que não estiver na lista, informe o ID em **Outro modelo**. As keys ficam em `api-keys.json`, ao lado do perfil (`~/.local/share/sidenote/` no Linux, `%APPDATA%\Sidenote\` no Windows), legíveis só pelo seu usuário; a interface nunca recebe a key de volta, só os últimos caracteres. Sem key salva, o app usa a variável de ambiente do provedor (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`...). As keys também são repassadas ao OpenCode, que então oferece os modelos desses provedores.

Nesses provedores o histórico da conversa fica na memória do backend e vai junto a cada pergunta, até ser apagado por **Nova sessão**. Em **Raciocínio**, **Padrão** não envia nível de esforço; OpenAI, Anthropic, Gemini e OpenRouter aceitam Low, Médio e High (modelos sem raciocínio podem recusar o parâmetro). Nos modelos Claude Fable 5.1, Opus 5.5, Opus 5 e Sonnet 5.5 o app ativa o fallback de recusa da Anthropic, que reenvia a pergunta a outro modelo se a resposta for recusada.

### Modelos locais (Ollama e LM Studio)

**Menu → Modelos locais** (ou **Modelos locais** no seletor) roda a IA no próprio computador, sem conta, sem key e sem mandar a conversa para a internet.

Ao abrir, o app escaneia o hardware: CPU, RAM e placas de vídeo com a memória de cada uma (NVIDIA pelo `nvidia-smi`; AMD e Intel pelo `/sys/class/drm` no Linux e pelo registro no Windows; memória unificada no Apple Silicon). Com isso ele classifica cada modelo do catálogo como **Cabe na placa de vídeo**, **Divide placa de vídeo e RAM**, **Roda na CPU** ou **Não cabe nesta máquina**, com a velocidade esperada ao vivo, e marca como **Recomendado** o de melhor qualidade que ainda responde rápido. Modelos MoE (GPT-OSS, Qwen 3.6 35B) leem poucos pesos por fala e continuam rápidos mesmo divididos com a RAM.

| Máquina | Recomendação típica |
| --- | --- |
| Só CPU, 8 GB de RAM | Qwen 3.5 2B |
| Só CPU, 16 GB | Qwen 3.5 4B |
| Só CPU, 32 GB | GPT-OSS 20B (MoE) |
| Placa de 8 GB | Gemma 4 12B |
| Placa de 24 GB | Qwen 3.6 27B |
| Mac com 128 GB de memória unificada | GPT-OSS 120B |

Os downloads usam o [Ollama](https://ollama.com). Sem ele instalado, a tela mostra o comando de instalação (Linux) ou o link de download; instalado mas parado, **Iniciar** abre o `ollama serve` (encerrado junto com o app). **Baixar** mostra o progresso e pode ser cancelado; um modelo baixado ganha **Usar**, que o escolhe em **Modelo**, e a lixeira o apaga do disco. Modelos já baixados fora do app também aparecem, com quanto deles está na placa de vídeo quando carregados. Placas AMD dependem do suporte do Ollama (ROCm ou Vulkan); se a sua não for compatível, o modelo roda na CPU.

O app carrega o modelo na memória ao selecioná-lo e o mantém carregado por 30 minutos, pede ao Ollama uma janela de contexto de 8 mil tokens (o padrão de 4 mil cortaria o prompt do copiloto) e, em **Raciocínio**, começa em **Sem raciocínio**, o mais rápido para respostas ao vivo. Low, Médio e High ligam o raciocínio dos modelos que têm esse modo.

O [LM Studio](https://lmstudio.ai) também é detectado: com o servidor local ligado (no LM Studio em Developer → Start Server, ou **Ligar o servidor** no app, que usa `lms server start`), os modelos baixados nele aparecem para usar. Downloads do LM Studio continuam sendo feitos nele.

## Meu contexto

O ícone de pessoa na barra inferior abre o editor em tela cheia. Um ponto azul no ícone indica que o perfil ainda está vazio. Preencha apenas fatos que você consiga sustentar na entrevista; campos vazios são ignorados.

| Aba | Campos |
| --- | --- |
| Perfil | **Importar currículo**, nome, cargo atual, anos de experiência, nível, **linguagem preferida**, tecnologias (Enter ou vírgula para adicionar) e resumo profissional. |
| Experiências | Até 8 histórias reais, cada uma com título e descrição (problema, o que você fez, resultado). |
| Vaga | **Importar descrição da vaga**, empresa, vaga, **sobre a empresa e os produtos**, requisitos e motivação. **Limpar vaga** apaga só essa aba, para a próxima entrevista. |
| Extras | Notas livres (pretensão, disponibilidade, inglês…), **Importar contexto.md** e a prévia do texto enviado à IA. |

### Importar currículo e vaga

Arraste um arquivo para a área **Importar currículo** (aba Perfil) ou clique nela para escolher. São aceitos PDF com texto selecionável, DOCX, TXT e MD, até 10 MB. O backend extrai o texto e pede ao provedor selecionado em **Menu → Modelo** que o organize nos campos: nome, cargo, nível, anos, linguagem preferida, tecnologias, resumo, até 8 experiências e, em Extras, formação, idiomas e links. A leitura costuma levar de alguns segundos a um minuto.

A área **Importar descrição da vaga** (aba Vaga) faz o mesmo com o anúncio da vaga ou um material sobre a empresa: preenche empresa, vaga, **Sobre a empresa e os produtos** e requisitos.

Com o [Google conectado](#google-agenda-e-docs), as duas áreas também aceitam o link de um Google Docs: cole em **Ou cole o link de um Google Docs** e clique em **Importar**. O texto do documento (todas as abas, títulos e tabelas) passa pela mesma organização.

A importação só altera o rascunho do editor: revise os campos e clique em **Salvar**, ou cancele para descartar. Campos que o documento não traz mantêm o que você já tinha escrito, tecnologias são somadas à lista e o texto de Extras é acrescentado. Os campos preenchidos substituem os anteriores, e as experiências são trocadas pelas do currículo. Se o provedor falhar, o texto extraído vai para Extras (currículo) ou para **Sobre a empresa** (vaga), para que nada se perca.

A organização roda num processo separado do CLI, com o modelo selecionado e esforço baixo, então o documento não entra na conversa da entrevista. O texto do arquivo é enviado ao provedor; PDFs escaneados (só imagem) não têm texto para extrair.

### Contexto da empresa

Em **Sobre a empresa e os produtos**, descreva o que a empresa faz, seus produtos (por exemplo, de IA ou de infraestrutura), clientes, stack e o momento do time. As sugestões usam esse contexto para conectar a resposta aos produtos e desafios da empresa quando fizer sentido, sem forçar a ligação em toda fala e sem inventar fatos sobre ela.

<p align="center">
  <img src="screenshots/vaga.png" width="320" alt="Aba Vaga preenchida a partir da descrição da vaga, com o contexto da empresa">
</p>

A linguagem preferida (por exemplo, TypeScript) vira o padrão das soluções de código no chat e é citada nas sugestões faladas, a menos que a pergunta peça outra linguagem.

**Salvar** (ou Ctrl+S) grava todas as abas de uma vez. Fechar com alterações pendentes pede confirmação antes de descartar. O contexto completo aceita até 10.000 caracteres; o contador fica no rodapé.

O perfil é salvo pelo backend em `~/.local/share/sidenote/profile.json` (ou `$XDG_DATA_HOME/sidenote/profile.json`); no Windows, em `%APPDATA%\Sidenote\profile.json`. O arquivo fica fora dos dados do Electron e do armazenamento do navegador, então continua disponível ao reiniciar o app, iniciar uma **Nova Sessão**, limpar os dados do app, trocar entre desenvolvimento e o pacote (AppImage ou Windows) ou reinstalar. A variável `SIDENOTE_PROFILE_PATH` troca o local. Um contexto salvo por versões anteriores no armazenamento local é migrado automaticamente para as notas na primeira abertura.

O contexto acompanha os pedidos de **Diga isso**, tanto automáticos quanto manuais. Mensagens digitadas e do microfone seguem o fluxo direto do agente e recebem apenas a linguagem preferida.

Para deixar de anexar o contexto, limpe os campos e salve. Isso não remove informações já enviadas à conversa do provedor. **Importar contexto.md** acrescenta o arquivo da raiz do projeto às notas; o app não escreve nesse arquivo e não acompanha alterações nele.

## Notas do Obsidian

**Menu → Notas** conecta uma vault do Obsidian. Escolha a pasta (ou digite o caminho) e clique em **Conectar**. O backend lê os arquivos `.md` da vault, ignora `.obsidian`, `.trash` e pastas ocultas, e monta um índice de busca em memória. Cada seção da nota (cada título `#`) vira um trecho. Edições, notas novas e exclusões são reindexadas automaticamente. A pasta escolhida fica em `notes.json`, ao lado do `profile.json`, e é reconectada ao abrir o app.

Durante a fala do PC, a transcrição parcial já é usada como busca. Quando aparecem trechos relacionados, um card verde **SUAS NOTAS** mostra a nota, a seção e o trecho com as palavras encontradas em destaque, antes de o modelo começar a responder. Ao consolidar a fala, os até 3 melhores trechos (no máximo 2.000 caracteres) vão no prompt do **Diga isso**, que deve usar os valores exatos das notas. Mensagens digitadas e do microfone também buscam nas notas, mostram o card e anexam os trechos.

A busca é por palavras (BM25), sem acentos e com variações simples, como plural e terminações de verbo ("liderou" encontra "liderei"). Ela não entende sinônimos: se a nota diz "p99" e a pergunta diz "percentil", a nota pode não aparecer. Use os títulos das seções para nomear o assunto. Conversa casual e perguntas sem relação não trazem trechos, e nesse caso o prompt fica igual ao de antes. Use **Testar uma pergunta**, na mesma tela, para conferir o que uma pergunta encontra.

São indexados até 5.000 arquivos de até 512 KB. Notas, anexos e imagens não saem do computador; só os trechos encontrados vão ao provedor, junto com a pergunta.

## Google Agenda e Docs

**Menu → Google** conecta sua conta Google. A conexão usa um cliente OAuth seu, criado uma vez no Google Cloud:

1. Em [console.cloud.google.com](https://console.cloud.google.com/apis/credentials), crie um projeto e ative as APIs **Google Calendar**, **Google Docs** e **Google Drive**.
2. Em **Tela de consentimento OAuth**, escolha "Externo" e adicione seu e-mail como usuário de teste.
3. Em **Credenciais → Criar credenciais → ID do cliente OAuth**, escolha **App para computador** e cole o Client ID e o Client secret no Sidenote.

**Conectar conta Google** abre o login no navegador; ao autorizar, a página diz para voltar ao app. O Sidenote pede só leitura dos eventos da agenda, leitura dos Docs e acesso aos arquivos que ele mesmo criar no Drive. As credenciais ficam em `google.json`, ao lado do perfil, legíveis só pelo seu usuário, e a interface nunca recebe os tokens. **Desconectar** apaga os tokens e revoga o acesso no Google. Também dá para passar o cliente por `SIDENOTE_GOOGLE_CLIENT_ID` e `SIDENOTE_GOOGLE_CLIENT_SECRET`.

**Agenda.** A tela lista os eventos de agora até o fim de amanhã (os recusados ficam de fora). **Usar nesta reunião** coloca o evento no contexto da sessão: título, horário, organizador, participantes, descrição e o texto de até 2 Google Docs anexados ao evento (uma pauta, por exemplo) vão junto com cada sugestão, mensagem direta e resumo. Quando há uma reunião na agenda acontecendo agora (ou começando em 10 minutos), uma faixa azul acima da transcrição oferece **Usar como contexto**; com um evento escolhido, a mesma faixa mostra qual é e o × o tira. **Nova sessão** guarda o evento na reunião do histórico e limpa a escolha para a próxima.

**Docs.** No **Resumo**, o botão de upload cria um Google Docs com o resumo e a transcrição da sessão e mostra o link. No **Histórico**, o mesmo botão cria o documento da reunião uma vez e depois passa a abri-lo. Em ⚙, **Salvar reuniões terminadas no Google Docs** faz isso sozinho ao fim de cada reunião. Para importar um Google Docs no perfil, veja [Importar currículo e vaga](#importar-currículo-e-vaga).

## Áudio e respostas

A captura do PC usa a saída de áudio padrão (ou o aplicativo escolhido, veja abaixo) e tenta iniciar quando o app abre. No Linux, o backend lê o monitor da saída com `parec`; no Windows, a janela do Electron captura o loopback do sistema (o que está tocando nos alto-falantes ou fones) e envia o áudio ao backend pela conexão local. Os medidores permitem acompanhar e controlar a captura. A transcrição parcial aparece enquanto a pessoa fala. Com Antigravity ou um provedor por API key, o modo automático já mostra uma prévia da sugestão durante a fala e a atualiza conforme a pergunta cresce; a prévia vira a resposta quando a fala consolidada for igual a ela. Com Codex, Claude Code e OpenCode, só a fala consolidada vai ao modelo.

Após cerca de 900 ms de silêncio, o app encerra o trecho. Uma pausa no meio da pergunta também pode encerrá-lo: a detecção é baseada em áudio, sem análise semântica do fim da pergunta. Se isso atrapalhar a entrevista, desative o modo automático e use **Diga isso** após conferir a transcrição. O botão usa a última fala consolidada; ele não junta automaticamente vários trechos.

### Ouvir só a janela da reunião

No Linux, em **Medidores de Áudio**, o seletor abaixo de **PC CALL** troca **Desktop inteiro** pelo áudio da chamada (Zoom, Teams, Discord, o navegador com o Meet). A lista mostra cada áudio que está tocando, com o nome do aplicativo, o título da janela quando o X11 permite (`xdotool`) e o nome do áudio quando o aplicativo informa um. O app grava só esse áudio (`parec --monitor-stream`), então música, vídeos e notificações de outros programas ficam fora da transcrição. A escolha é lembrada nas próximas aberturas.

Um navegador toca as abas como áudios separados, mas iguais na lista (**Zen · áudio 1 de 2**, **áudio 2 de 2**). Para saber qual é o da chamada, abra a lista (ou clique em ↻) enquanto alguém fala: o app mede cada áudio por meio segundo e marca o que está **com som agora**. Se o aplicativo escolhido toca mais de um áudio, um aviso pede para conferir a escolha.

Se a chamada ainda não começou, o app espera: os medidores mostram **aguardando** em âmbar (também no modo compacto) e nada é transcrito até o aplicativo tocar áudio. Se a chamada recriar o áudio (uma reconexão), a captura acompanha quando não há dúvida: só um áudio novo apareceu, ou ele tem o mesmo nome do anterior. Os áudios que já tocavam ao lado da chamada (outra aba com vídeo, por exemplo) nunca são tomados por ela. Ao abrir o app, a escolha salva só é retomada direto se o aplicativo dá um nome próprio ao áudio ou se ele toca um áudio só, pois o número de um áudio pode ser reaproveitado por outra aba. Quando há dúvida, o app não escolhe por você: um aviso no topo, visível em qualquer modo, lista os áudios do aplicativo para você escolher o da chamada ou voltar ao **Desktop inteiro**. No Windows a captura continua sendo do desktop inteiro.

Áudio contínuo, como um vídeo ou música sem pausas, também é dividido: após 30 s de fala, o trecho é encerrado no primeiro momento mais baixo; se o áudio não baixar, ele é encerrado aos 45 s. Se o reconhecimento de um trecho falhar, o app descarta esse trecho e começa outro com o áudio seguinte, sem esperar uma pausa.

## Reconhecimento de voz

Em **Menu → Reconhecimento de voz** você escolhe quem transforma o áudio em texto, para o áudio do PC e para o microfone. O padrão é o **Parakeet**, que roda dentro do app e só precisa do modelo, baixado na tela de boas-vindas ou aqui. O **Google** é online, sem download, mas precisa do Python com `SpeechRecognition`. O Parakeet e os outros três rodam neste computador: o áudio não sai daqui, não há limite de uso e a transcrição continua sem internet (as sugestões ainda precisam do provedor).

| Motor | Onde roda | Download | Idioma automático |
| --- | --- | --- | --- |
| Google | Servidores do Google | — | Sim, pede os dois idiomas ao mesmo tempo |
| Parakeet TDT 0.6B v3 (padrão) | CPU, dentro do app | 670 MB | Sim, pelas palavras reconhecidas |
| Whisper large-v3-turbo | GPU (Vulkan) ou CPU | 574 MB | Sim, detectado pelo Whisper |
| Whisper small / base | CPU | 486 / 148 MB | Sim, detectado pelo Whisper |
| Vosk | CPU | 32 MB (pt) + 41 MB (en) | Não; veja abaixo |

Cada cartão resume o modelo (os números ficam em **Detalhes**) e mostra o que falta para usá-lo. Quando falta o pacote Python (Google, Whisper e Vosk), o botão **Instalar** o instala no Python do app (no Linux, num venv em `~/.local/share/sidenote/venv`); se falhar, o cartão mostra o erro e o comando para rodar à mão. O `whisper-server` (só para o Whisper large-v3-turbo) você compila; o modelo você baixa ali mesmo, com progresso, cancelamento e opção de apagar. O botão **Usar** aparece quando não falta nada. A velocidade e a qualidade medidas neste projeto estão em [Áudio e latência](response-latency.md#reconhecimento-local); rode o mesmo teste com as suas gravações para comparar no seu computador.

O modelo é carregado quando a captura começa (de menos de 1 s a alguns segundos, uma vez por execução) e fica na memória enquanto o app estiver aberto. Um motor local reconhece um pedido por vez: enquanto ele trabalha, o app não acumula trechos, só manda o áudio mais recente quando ele termina. Por isso, numa máquina lenta, o texto parcial atualiza com menos frequência, mas a fala completa sempre é transcrita.

No idioma **Auto**, cada motor decide entre português e inglês do seu jeito. O Whisper detecta o idioma; se achar outro (espanhol, por exemplo), transcreve de novo em português ou inglês (o mais provável dos dois no small/base; o último idioma ouvido no large-v3-turbo). O Parakeet não informa o idioma: o texto sai no idioma falado, e o app o classifica pelas palavras. O Vosk não detecta idioma: no modo automático, cada modelo instalado (português e inglês) transcreve a fala e vence o de melhor confiança, o que dobra o trabalho e às vezes escolhe errado; com só um modelo instalado, ele é usado para tudo. Fixe o idioma no menu quando a reunião for toda num idioma só.

Se o motor local não carregar (pacote ou modelo ausente, `whisper-server` que não abre) ou falhar 3 vezes seguidas, o app passa a usar o Google (se o Python estiver instalado) e mostra um aviso no topo uma vez. Uma falha avulsa só manda aquela fala ao Google. O motor volta a ser usado quando você o escolhe de novo na janela de reconhecimento.

## Resumo da sessão

A aba **Resumo** mostra um resumo da conversa com visão geral, tópicos e perguntas, pontos de atenção, decisões e próximos passos. Ele usa a transcrição inteira da sessão: o que o interlocutor disse no áudio do PC, o que você falou ou digitou e, só como contexto, as sugestões da IA. O pedido roda num processo separado do CLI, então o resumo não entra no chat, não interrompe a resposta ao vivo nem aparece no histórico do modelo.

Com **Atualizar automaticamente** ligado, o resumo é refeito em segundo plano depois de 4 falas novas e 15 segundos, esperando a resposta ao vivo terminar. **Atualizar agora** gera na hora e mostra o texto enquanto ele é escrito. Em sessões muito longas, a atualização parte do resumo anterior mais as falas novas. Cada resumo começa com um título curto escolhido pelo modelo, mostrado acima do texto; é ele que nomeia a reunião no histórico.

Em ⚙ escolha o **Modelo do resumo**: o mesmo da conversa ou um modelo dedicado de qualquer provedor disponível. Um modelo rápido (Flash, Haiku, Luna) basta.

O botão de pasta salva o resumo e a transcrição completa em Markdown na pasta `sessions` ao lado do perfil (`~/.local/share/sidenote/sessions` no Linux). O botão de livro salva na pasta `Sidenote` da vault do Obsidian conectada, onde o arquivo passa a ser indexado com as outras notas. Com o Google conectado, o último botão cria um [Google Docs](#google-agenda-e-docs) com o mesmo conteúdo. Com **Salvar sessão ao iniciar uma nova** ligado, **Nova sessão** também salva a sessão anterior em Markdown em `sessions`, com o título escolhido pelo modelo no nome do arquivo. O resumo final e o [histórico](#histórico-de-reuniões) são gerados de qualquer forma.

## Histórico de reuniões

A aba **Histórico** (ícone de relógio) guarda cada reunião encerrada. Uma reunião termina ao iniciar uma **Nova sessão** (Alt+N) ou ao fechar o app; se o app fechar no meio, a reunião é recuperada na próxima abertura e resumida em seguida. O mesmo modelo do resumo escreve o resumo final e decide o título pelo assunto da conversa; a data e a hora mostradas são as da última fala. Se o resumo da aba **Resumo** já cobre a conversa inteira, ele e o título dele são reaproveitados sem nova chamada ao modelo.

A busca procura no título, no resumo e na transcrição, sem diferenciar maiúsculas nem acentos; com várias palavras, todas precisam aparecer. Títulos que batem vêm primeiro, e cada resultado mostra o trecho encontrado. Ao abrir uma reunião você vê o resumo e a transcrição completa, pode copiar o resumo, apagar a reunião ou, se o resumo falhou, **Gerar resumo e título** de novo.

Cada reunião é um arquivo JSON na pasta `history` ao lado do perfil (`~/.local/share/sidenote/history` no Linux). Reuniões com menos de duas falas não são guardadas.

## Modo compacto

Ative pelo **Menu → Modo compacto** ou com **Alt+C** (app em foco). A janela encolhe no lugar e mostra só a última resposta do agente, com as configurações do menu, os medidores do PC e do microfone (clique no medidor do PC para ligar ou desligar a captura) e o botão para voltar ao modo normal. A abas, o feed de transcrição e a barra inferior ficam ocultos. Ao voltar, a janela recupera o tamanho anterior. A escolha é lembrada entre execuções.

O microfone grava uma mensagem para o agente. Clique para iniciar e parar, ou segure **Espaço** e solte para enviar. Digitar pelo botão de teclado também envia uma mensagem direta ao agente.

**Diga isso** pede uma fala pronta para responder ao interlocutor, em tom profissional e conversacional. Perguntas técnicas usam conhecimento geral mesmo quando o assunto não aparece no perfil. Perguntas hipotéticas recebem uma proposta no condicional, com passos e justificativa. Para experiências passadas, o modelo deve usar somente fatos informados: pode aproveitar uma experiência relacionada e indicar uma abordagem hipotética, sem transformar isso em uma história real. Dados pessoais ausentes, como salário ou disponibilidade, continuam exigindo confirmação.

O backend mantém uma janela limitada de falas consolidadas do PC e mensagens enviadas por texto ou microfone, inclusive com o modo automático desligado. Essa janela acompanha as sugestões para dar sentido a perguntas como “por quê?” ou “nesse projeto?”. Respostas da IA não são armazenadas nessa memória como fatos pessoais. Ela fica em memória durante a sessão, é compartilhada na troca de provedor e é apagada por **Nova Sessão** ou ao reiniciar o backend. O microfone continua sendo uma mensagem manual ao agente; ele não registra continuamente tudo o que você diz na chamada.

## Captura de tela

**Ctrl+Alt+S** envia uma captura do monitor ao agente como mensagem. Se não houver texto, o app pede a resolução da questão mostrada na tela (por exemplo, um exercício com enunciado e exemplos) e, se houver um editor com a assinatura da função, usa a mesma linguagem e assinatura. A janela do app é retirada da imagem durante a captura.

O monitor fica em **Menu → Captura**; clique para alternar entre **Auto · cursor** (o monitor onde está o cursor, padrão) e os monitores conectados. A escolha é lembrada entre execuções. Se o monitor escolhido estiver desligado, o app usa o do cursor. No Linux, o nome dos monitores vem de `xrandr`.

A imagem é reduzida para no máximo 1920 px no maior lado e enviada em JPEG. Uma mensagem aceita até 4 imagens. No feed, a captura aparece como sua mensagem; a memória da conversa guarda somente um marcador, não a imagem.

## Atalhos

| Atalho | Ação | Disponibilidade |
| --- | --- | --- |
| Alt+Space | Alternar microfone | Global no Electron e app em foco |
| Ctrl+D | Pedir uma sugestão para a última fala | Global no Electron |
| Ctrl+B | Ocultar ou mostrar a janela | Global no Electron |
| Ctrl+Alt+P | Alternar captura do PC | Global no Electron |
| Ctrl+Alt+M | Alternar microfone | Global no Electron |
| Ctrl+Alt+N | Iniciar nova sessão (a reunião atual vai para o Histórico) | Global no Electron |
| Ctrl+Alt+S | Enviar captura da tela ao agente (monitor escolhido em **Menu → Captura**; padrão: o do cursor) | Global no Electron |
| Alt+N ou Ctrl+Shift+R | Iniciar nova sessão (a reunião atual vai para o Histórico) | App em foco |
| Alt+C | Alternar modo compacto | App em foco |
| Ctrl+= / Ctrl+- / Ctrl+0 | Aumentar, diminuir ou restaurar o texto do feed (faixa de 70% a 200%, lembrada no app) | App em foco |
| Espaço, segurando | Gravar pelo microfone; soltar envia | App em foco, fora de campos de texto |

Atalhos globais podem conflitar com o ambiente desktop ou com outros programas (no Windows, Ctrl+D e Alt+Space ficam reservados ao app enquanto ele está aberto); no Linux, Alt+Shift costuma ser a troca de layout de teclado, por isso os atalhos globais usam Ctrl+Alt. Os botões da interface continuam disponíveis.

## Dados e limites

Com o Google (o padrão), o áudio de cada fala vai ao serviço gratuito do Google por meio da biblioteca Python `SpeechRecognition`, e a transcrição precisa de internet. Com um motor local, o áudio não sai do computador; se o motor local falhar, as falas daquele momento vão ao Google, e o app avisa. Em qualquer caso, o texto reconhecido e o contexto salvo são enviados ao provedor quando uma sugestão é solicitada.

Currículos e descrições de vaga importados são enviados ao provedor uma vez, para organizar os campos; o arquivo não é guardado pelo app, apenas o perfil que você salvar.

Dos arquivos da vault do Obsidian, só os trechos encontrados para cada pergunta vão ao provedor.

Com um modelo local (Ollama ou LM Studio), o prompt, a transcrição e o contexto ficam no computador: nada vai a um provedor externo.

Com o Google conectado, o evento escolhido e o texto dos Docs anexados a ele vão ao provedor junto com cada pedido daquela sessão. Exportar para o Google Docs envia o resumo e a transcrição ao seu Drive.

O histórico de reuniões fica só neste computador. A transcrição de cada reunião encerrada vai ao provedor do resumo uma vez, para gerar o resumo final e o título.

Capturas de tela são enviadas ao provedor somente quando você usa Ctrl+Alt+S; não há captura contínua. Com o Antigravity, que recebe apenas texto no fluxo do agente, a imagem é gravada como arquivo temporário em `sidenote-screenshots` na pasta temporária do sistema e removida após 1 hora. Quem tiver acesso a essa pasta na máquina pode ler a captura durante esse período. Por isso, evite capturar telas com dados sensíveis que não devam ir ao provedor.

Os CLIs usam a autenticação já configurada na máquina. O fluxo de mensagens diretas pode executar ferramentas do agente; a instrução para responder sem ferramentas pertence ao prompt do copiloto, não é um isolamento de segurança.

Erros de reconhecimento aparecem na interface e impedem o envio daquela transcrição incompleta. Rede lenta, fila de reconhecimento e geração do modelo podem aumentar a espera. Consulte o [diagnóstico de latência](response-latency.md).
