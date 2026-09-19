# opencode-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | **Português** | [Русский](./README.ru.md)

> **Também usa zcode?** Confira o [zcode-switchman](https://github.com/mrzturn/zcode-switchman) — um projeto open source irmão, do mesmo autor, que leva a mesma orquestração aos usuários do zcode.

> O contexto tem medidor. As tarefas se despacham sozinhas.

![opencode-switchman — o nível d'água do contexto comanda o switchman e traça a rota](docs/assets/hero.svg)

> Demo interativa: [opencode-switchman em ação](https://mrzturn.github.io/opencode-switchman/)

Um plugin de orquestração para o [OpenCode](https://opencode.ai). Ele faz duas coisas, e faz bem:

**1. Controle do nível do contexto.** O contexto da sua sessão é medido a cada turno. As leituras rodam contra um orçamento por turno, então o modelo não consegue engolir o repo inteiro em silêncio; as marcas soft / hard / force disparam primeiro um conselho, depois o wrap-up, e então um handover automático com backup e compactação; cada subagente despachado carrega seu próprio hard cap. O contexto para de acumular — uma sessão pode rodar o dia inteiro sem que os tokens sejam devorados pela própria história.

**2. Despacho automatizado de decisões.** Seu modelo primário vira um dispatcher: ele perfila cada tarefa e a delega a shells subagente em seis faixas cognitivas (economy / mechanical / main / hard / vision / review). O plugin impõe gates determinísticos, pontuação ponderada por modelo e isolamento de falhas com autorreparo, e registra cada decisão de roteamento.

E por cima disso:

- **Vários modelos ou assinaturas? Este plugin foi feito para você.** GitHub Copilot, GLM Coding Plan, DeepSeek — ou qualquer provider do opencode — são orquestrados como um único pool: ordenação ciente de cotas, evitação de janelas de pico, review entre famílias forçada.
- **Só um modelo? Ainda vale a pena.** O controle de contexto e o despacho inteligente, sozinhos, mantêm um único modelo utilizável indefinidamente — por mais longa que seja a sessão, o contexto nunca incha.

## Instalação

Um comando — cobre a primeira instalação e as atualizações seguintes. Reinicie o opencode depois.

```bash
curl -fsSL https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/setup.sh | bash
```

ou

```bash
npx -y opencode-switchman@latest
```

ou

```bash
bunx opencode-switchman@latest
```

Qualquer um dos caminhos reescreve a entrada `plugin` na sua configuração do opencode para a versão exata mais recente e remove caches velhos. Instalação npm manual, build a partir do código-fonte e a nota sobre o "porquê de versões exatas": [Detalhes de instalação](./docs/reference.md#installation).

Prefere não mexer? Deixe sua IA fazer a instalação — cole este prompt na IA que você usa:

<details open>
<summary><strong>Prompt de instalação assistida por IA</strong></summary>

```text
Instale e configure o plugin opencode-switchman para o meu opencode, seguindo rigorosamente as instruções oficiais dele.

Fontes oficiais (autoritativas, não adivinhe de memória):
- Repo GitHub: https://github.com/mrzturn/opencode-switchman
- Pacote npm: https://www.npmjs.com/package/opencode-switchman
Leia a seção "Instalação" do README do repo e siga-a exatamente.

Passos:
1. Instale a versão mais recente publicada no npm: execute `npx -y opencode-switchman@latest` (ou `bunx opencode-switchman@latest`) — isso reescreve a entrada `plugin` na minha configuração do opencode para a versão exata mais recente (também funciona no `opencode.json` de projeto, se for o que eu uso).
2. Complete a configuração funcional: todas as configurações do plugin vivem no arquivo autônomo `opencode-switchman.jsonc` no diretório de configuração do opencode, gerado automaticamente com padrões e comentários inline no primeiro início; confira-o contra os meus providers (ex. `zhipuai-coding-plan` / `deepseek` / `github-copilot`) e ajuste se necessário.
3. Verifique a corretude para que o opencode carregue, inicie e execute o plugin: execute `/switchman-doctor` dentro do opencode para um relatório de diagnóstico local sem credenciais e corrija todos os erros reportados; depois reinicie o opencode e confirme que o plugin foi mesmo carregado — o log deve conter `[opencode-switchman] injected N model shells (agents)` e o system prompt do meu modelo primário deve trazer o bloco de banner ao vivo `[ROUTES]/[WATERMARK]/[LIMITS]`.

Não declare sucesso antes dos três passos passarem; relate o que mudou e mostre as evidências de verificação.
```

</details>

**Pré-requisitos**: [opencode](https://opencode.ai), CLI/TUI recomendada (diálogos, sidebar e banners são mais completos lá; o app desktop compartilha a mesma configuração e estado). Qualquer provider funciona; Copilot / GLM / DeepSeek ganham adicionalmente o roteamento ciente de cotas. As credenciais são lidas apenas para leitura da própria autenticação do opencode — o plugin nunca armazena segredos.

## Início rápido

Seis passos. Guia completo com capturas de tela: **[docs/quick-start.md](./docs/quick-start.md)** / [中文](./docs/quick-start.zh.md).

1. **Conecte os providers** — `/connect` na TUI: OAuth do Copilot, API key do DeepSeek; o GLM Coding Plan vai no `opencode.json` como provider personalizado `zhipuai-coding-plan`.
2. **Escolha os modelos que entram na orquestração** — `/models` e depois `ctrl+f` para favoritar (app desktop: interruptores em "Gerenciar modelos").
3. **`/switchman-setup`** *(obrigatório uma vez)* — o assistente guiado cobre a matriz inteira numa passada só: multisseleção de pelo menos um modelo para cada um dos seis pools de tarefas (economy / mechanical / main / hard / vision / review) e, em seguida, a ordenação dos modelos escolhidos do mais forte ao mais fraco. Sem TUI? O `/switchman-setup-chat` roda o mesmo fluxo guiado no chat. Até a configuração terminar, o despacho de tarefas fica bloqueado — pools não configurados não caem mais para "todos os modelos". A configuração salva recarrega a quente; um reinício só é preciso para registrar providers totalmente novos.
4. **Ajuste fino** *(opcional)* — o **`/modelRank`** ajusta manualmente o ranking de capacidade e o **`/poolConfig`** cura as listas de candidatos por pool nos diálogos da TUI (variantes `-chat` no chat); entradas manuais sobrescrevem os padrões iniciais em todos os lugares.
5. **Comandos de contexto**
   - **`/handover`** — faça você mesmo o backup da sessão e a compactação. Use quando a linha `[WATERMARK:SESSION]` estiver crescendo ou a tarefa chegar a um bom ponto de parada, em vez de esperar o handover automático.
   - **`/ctx-pause`** — desative os limites de leitura e o handover automático desta sessão. Use quando precisar ler muitos arquivos grandes de uma vez e não se importar de gastar tokens; a medição continua rodando.
   - **`/ctx-resume`** — reative os limites. Use assim que a leitura pesante terminar; reiniciar o opencode tem o mesmo efeito.
6. **Reinicie e verifique** — confira o banner `[ROUTES]`/`[LIMITS]` e o painel `switchman` na sidebar; rode `/switchman-doctor` se algo parecer errado. Depois é só usar o opencode normalmente.

## O que você ganha

**Núcleo**

- **Controle do nível do contexto** — medição da sessão ao vivo (`[WATERMARK:SESSION]`), limiares soft/hard/force, um orçamento de leitura por turno que limita sozinho leituras excessivamente ávidas, um hard cap com resumo-e-término para cada subagente, e um handover automático (fork de backup completo + compactação) no nível force.
- **Despacho automatizado de decisões** — um protocolo dispatcher embutido transforma seu modelo primário num dispatcher; seis faixas cognitivas encaminham o trabalho para o modelo certo com o esforço certo; seis gates determinísticos verificam cada despacho; falhas acionam breakers e isolamento, e o sistema se cura sozinho.

**Extras**

- **Orquestração multi-assinatura** — roteamento ciente de cotas entre Copilot / GLM / DeepSeek (qualquer provider participa), cedência em janelas de pico, pontuação ciente de cobrança, imposição de review entre famílias.
- **Overrides manuais** — `/switchman-setup`, `/poolConfig`, `/modelRank`, `/expert`, `/handover`, `/ctx-pause`, `/ctx-resume`, `/switchman-doctor`, `/switchman-update`.
- **Visibilidade** — banner ao vivo de quatro linhas em cada system prompt, painel na sidebar da TUI, espelhamento em painéis tmux, workspace de artefatos por sessão, e um log de auditoria de cada decisão de roteamento.

Tabela completa de opções, arquitetura e detalhes internos: [docs/reference.md](./docs/reference.md) (中文: [docs/reference.zh.md](./docs/reference.zh.md)).

## Documentação

- Início rápido (ilustrado): [English](./docs/quick-start.md) · [中文](./docs/quick-start.zh.md)
- Manual completo (configuração, comandos, arquitetura): [English](./docs/reference.md) · [中文](./docs/reference.zh.md)
- Especificação técnica (contratos / algoritmos / notas de campo): [docs/2026-08-28-opencode-switchman-technical-design.md](./docs/2026-08-28-opencode-switchman-technical-design.md)
- Notas de versão: [CHANGELOG.md](./CHANGELOG.md)

## Roadmap

Curto prazo: suporte a cotas para mais providers — mais planos de assinatura e pools pay-as-you-go além de Copilot / GLM / DeepSeek. Se o seu provider ainda não está coberto, [abra uma issue](https://github.com/mrzturn/opencode-switchman/issues): o uso real decide o que vem a seguir. Sugestões e relatórios de bugs são igualmente bem-vindos.

## Apoie o autor

Este plugin é open source e gratuito, e continuará assim. Mantê-lo vivo, porém, não é de graça: dar suporte e testar a compatibilidade de adaptadores entre providers significa manter várias assinaturas e depurar uma a uma — cada rodada custa dinheiro de verdade.

Se o plugin realmente te ajudou e o seu orçamento permite, me pague um café. Obrigado — sinceramente.

👇

<details>
<summary>☕ Clique aqui 【Pague um café ao autor】</summary>

| Alipay | WeChat Pay | Escaneie com WeChat e deixe um like |
|:---:|:---:|:---:|
| <img src="docs/pay/alipay.png" width="150" alt="QR code do Alipay" /> | <img src="docs/pay/wechat_pay.jpg" width="150" alt="QR code do WeChat Pay" /> | <img src="docs/pay/wechat_pay_2.jpg" width="150" alt="QR code WeChat scan-to-like" /> |

</details>

## Licença

[MIT](./LICENSE)
