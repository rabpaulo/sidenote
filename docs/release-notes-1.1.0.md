# Sidenote 1.1.0 release notes

## Internal release summary

- Posicionamento como copiloto de reuniões:
  - A aba **Vaga** de **Meu contexto** virou **Conversa**: empresa, assunto, sobre a empresa e os produtos, pontos importantes e seu objetivo na conversa. A importação aceita pauta, proposta ou material da empresa.
  - No **Perfil**, a importação aceita currículo ou bio, e as tecnologias viraram **Áreas e ferramentas**. **Nível** e **Linguagem preferida** só aparecem nos modos de entrevista.
  - Em **Modo**, a primeira categoria é **Reuniões**, com **Reunião ou conversa**. Os modos de entrevista continuam disponíveis no fim da lista.
  - Os prompts falam de reunião e de usuário em vez de entrevista e candidato; README, guias e a página do projeto acompanham.
- Provedores e modelos:
  - O seletor mostra só os provedores encontrados na máquina (CLIs instalados, keys salvas ou em variáveis de ambiente, runtimes locais) e recolhe os demais em **Outros provedores**, com o que falta para cada um.
  - **Modelos locais** pelo Ollama e pelo LM Studio: o app escaneia CPU, RAM e placa de vídeo, recomenda o modelo mais adequado e baixa com um clique.
- Google Agenda e Docs: a reunião da agenda (participantes, descrição e Docs anexados) entra no contexto das sugestões e do resumo; Docs podem ser importados em **Meu contexto**, e reuniões podem ser salvas no Docs. O app traz um cliente OAuth próprio e uma política de privacidade publicada.
- Desempenho: o modelo de fala carrega sob demanda, o pool de agentes é menor e a interface renderiza menos, reduzindo CPU e memória em repouso.
- Screenshots refeitos a partir de uma reunião simulada; os de perfil de candidato saíram.
- Distribuição: esta versão não traz instaladores. Clone o repositório e rode com `npm start` ou gere o pacote com `npm run build:appimage` (Linux) ou `npm run build:win` (Windows).
- Advances release identity to version `1.1.0`.

## Upgrade notes

- Perfis salvos continuam valendo: só os rótulos mudaram, os campos gravados em `profile.json` são os mesmos.
- **Google Agenda e Docs exigem um cliente OAuth próprio.** O repositório não traz o cliente do Google. Para usar a integração, crie o seu no Google Cloud (tipo **App para computador**, uns 5 minutos) e cole em **Menu → Google**; o passo a passo está no [guia de uso](https://github.com/rabpaulo/sidenote/blob/main/docs/usage.md#google-agenda-e-docs). O resto do app funciona sem isso.
