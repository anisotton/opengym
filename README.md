<div align="center">

# ballet-opengym

**Condicionamento físico e planejamento de aulas de técnica para o balé.**

Uma plataforma SaaS para escolas de balé e bailarinas: rotinas de condicionamento pensadas para
a dança, acompanhamento de cargas e esforço, mapa de fadiga muscular e, em breve, o planejamento
de aulas de barra e centro por nível.

<br>

[![Licença: AGPL v3](https://img.shields.io/badge/licen%C3%A7a-AGPL--3.0-a3e635?style=flat-square)](LICENSE)
![Status](https://img.shields.io/badge/status-em%20desenvolvimento-f59e0b?style=flat-square)
[![Fork do openGym](https://img.shields.io/badge/fork%20do-openGym-60a5fa?style=flat-square)](https://github.com/DuarteSantos8/openGym)
![PWA](https://img.shields.io/badge/PWA-instal%C3%A1vel-a78bfa?style=flat-square)

</div>

> **ballet-opengym é uma versão modificada do [openGym](https://github.com/DuarteSantos8/openGym),
> de Duarte Santos**, distribuída sob a mesma licença **GNU AGPL v3.0**. Veja
> [Origem e créditos](#origem-e-créditos) e [Licença](#licença).

## O que é

A bailarina precisa de força, flexibilidade e controle tanto quanto de técnica, e a maior parte
desse trabalho acontece fora da aula: no fortalecimento de pés e tornozelos, no en dehors, no
core, na preparação para a ponta. O ballet-opengym organiza esse trabalho e o conecta às aulas de
técnica.

O produto é oferecido como **SaaS**, em dois planos:

| Plano | Para quem | O que inclui |
|---|---|---|
| **Escola** | Escolas de balé | Conta da escola com professoras, turmas e alunas; planos de condicionamento e de aula por nível |
| **Individual** | Bailarinas avulsas | Conta própria para acompanhar o condicionamento e a evolução |

## Funcionalidades

### Disponível hoje (herdado do openGym)

- 🗓️ **Plano semanal** — uma rotina por dia da semana, sobre uma biblioteca de exercícios pesquisável e navegável **por músculo** num mapa do corpo
- ▶️ **Treino guiado** — abre o treino do dia, preenche as cargas da última vez, cronômetro de descanso e detecção de recordes
- ⏱️ **Exercícios por tempo** — pranchas, isometrias e sustentações registradas em segundos, com cronômetro próprio
- ↔️ **Repetições por lado** — para exercícios unilaterais, como elevações de perna e trabalho de tornozelo
- 🌈 **Esforço por série (RIR / RPE)** — um toque registra o quanto a série foi difícil
- 📈 **Progressão de carga por regra** — linear, dupla progressão por faixa de repetições ou por tempo, por rotina ou por exercício
- 💪 **Mapa muscular** — equilíbrio (onde o volume foi), fadiga (o que ainda está se recuperando) e tempo desde o último estímulo de cada músculo
- 🖼️ **Exercícios próprios** — com nome, região do corpo, foto, GIF ou vídeo e link para um guia
- 📝 **Histórico completo** — edição de treinos passados, registro retroativo, mapa de atividade anual e estatísticas
- 🔑 **Login por passkey** (Face ID / Touch ID / digital), com login por senha opcional e perfis sincronizados entre dispositivos
- 📱 **PWA** — instalável na tela inicial do celular, funciona offline
- 🛠️ **Painel administrativo** — usuários, convites, bloqueio de contas e registro de atividade
- 🌍 **Interface em português do Brasil** e em outros 16 idiomas

### Em construção

- 🩰 **Biblioteca de condicionamento para o balé** — en dehors, fortalecimento de pés e tornozelos, preparação para a ponta, flexibilidade e core, com mídia própria
- 🎼 **Planejamento de aulas de técnica** — sequências de barra e centro (pliés, tendus, adagio, allegro) organizadas por nível
- 🏫 **Contas por escola (multi-tenant)** — escola, professoras, turmas e alunas, com os dados de cada escola isolados
- 💳 **Assinaturas** — planos Escola e Individual

## Rodando localmente

Você precisa do [Docker](https://docs.docker.com/get-docker/) com Compose.

```bash
git clone git@github.com:anisotton/opengym.git ballet-opengym
cd ballet-opengym
cp .env.example .env
docker compose up -d --build
```

Abra **http://localhost:8080** e crie um perfil. Use `--build` para gerar as imagens a partir
deste código: o `docker-compose.yml` herdado aponta para as imagens publicadas do openGym original,
que não contêm as modificações deste fork.

Na primeira execução, a instância baixa as mídias dos exercícios (~140 MB) de uma fonte externa.
Essas mídias **não pertencem a este projeto** — veja [Licença](#licença).

Para expor a instância com HTTPS e passkeys num domínio próprio, veja
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

### Configuração

Tudo é configurado pelo `.env`. Todas as variáveis estão documentadas em
[`.env.example`](.env.example). As principais:

| Variável | O que é | Padrão |
|---|---|---|
| `RP_ID` | Domínio ao qual as passkeys ficam vinculadas | `localhost` |
| `ORIGIN` | URL completa de onde o app é servido | `http://localhost:8080` |
| `WEB_PORT` | Porta da interface web no host | `8080` |
| `RP_NAME` | Nome exibido no pedido de passkey | `openGym` |
| `ADMIN_UIDS` | IDs de usuário com acesso ao painel admin (separados por vírgula) | *(nenhum)* |
| `INVITE_ONLY` | Exige código de convite para criar perfil | *(desligado)* |
| `PASSWORD_LOGIN` | Oferece login por nome/e-mail e senha além das passkeys | *(desligado)* |
| `ALLOW_GUEST` | Oferece "Continuar sem conta" — `0` exige perfil | *(ligado)* |

### Dados

Ficam em `./data` no host: `db.json` (perfis e passkeys públicas), `state-<usuário>.json` (plano,
treinos e configurações de cada usuário), `audit.log` e `secret`. **Faça backup de `./data`.**

## Tecnologia

```text
┌─────────────┐        ┌──────────────────────────────┐
│  Celular /  │──HTTPS─▶│  web  (nginx)                │
│  computador │        │   ├─ serve o app compilado   │
└─────────────┘        │   └─ faz proxy de /api ─────┐│
                       └──────────────────────────────┘│
                                                        ▼
                                        ┌──────────────────────────┐
                                        │  api  (Node + WebAuthn)  │
                                        │   └─ ./data (JSON)       │
                                        └──────────────────────────┘
```

- **frontend/** — React 19 + Vite (React Router, Zustand); PWA e app mobile via Capacitor
- **api/** — Node sem framework, com armazenamento em arquivos JSON; especificação OpenAPI em [`api/openapi.yaml`](api/openapi.yaml)
- **web/** — imagem multi-stage que compila o frontend e o serve com nginx na mesma origem da API

A lógica de treino (progressão, 1RM, leitura das sessões) está em funções puras em
`frontend/src/lib/`, com testes ao lado: rode `npm test` dentro de `frontend/`.

## Origem e créditos

O ballet-opengym nasceu como fork do **[openGym](https://github.com/DuarteSantos8/openGym)**, um
rastreador de treino open source criado por **Duarte Santos** e mantido com contribuições da
comunidade. Todo o motor de treino, sincronização, autenticação e interface vem desse projeto.

- **Projeto original:** https://github.com/DuarteSantos8/openGym
- **Versão de partida:** openGym v1.3.9 (commit `e88062e`)
- **Este fork:** https://github.com/anisotton/opengym, mantido por Anderson Isotton (Isotton Corp)

As mudanças feitas aqui ficam registradas no histórico do git (commits após `e88062e`). As
atualizações do projeto original são incorporadas periodicamente:

```bash
git remote add upstream https://github.com/DuarteSantos8/openGym.git
git fetch upstream
git merge upstream/main
```

"openGym" é o nome do projeto original. O ballet-opengym não é afiliado a ele nem endossado por
ele.

## Código-fonte

Este repositório contém o **código-fonte completo** de toda versão do ballet-opengym em
produção, inclusive a versão oferecida como SaaS. É o que exige a seção 13 da AGPL v3.0: quem usa
o sistema pela rede tem direito ao código-fonte da versão que está usando. O app tem um link
"source code" em Configurações que aponta para cá.

## Licença

O código do ballet-opengym, assim como o do openGym, está sob a
**[GNU Affero General Public License v3.0](LICENSE)**. Você pode usar, estudar, modificar e
redistribuir o código; se oferecer uma versão modificada como serviço de rede, precisa
disponibilizar o código-fonte dessa versão sob a mesma licença. O copyright original é de
**© 2026 Duarte Santos**; as modificações deste fork são de **© 2026 Anderson Isotton**.

**Conteúdo de terceiros não está coberto pela AGPL:**

- **Dados e instruções dos exercícios** — vêm do [ExerciseDB v1](https://exercisedb.dev/), por meio
  do [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset), sob licença
  **MIT**.
- **Imagens e animações dos exercícios** — conteúdo de terceiros **não coberto** nem pela MIT nem
  pela AGPL, com titularidade atualmente **em disputa** entre [Gym visual](https://gymvisual.com/)
  e ExerciseDB/AscendAPI. Este repositório **não as redistribui**: a instância as baixa da fonte
  original na primeira execução. Para o uso comercial, o ballet-opengym vai adotar **mídia própria**
  para os exercícios de balé.
- **Geometria do mapa corporal** — derivada do [MuscleMap](https://github.com/melihcolpan/MuscleMap),
  sob licença **MIT**.

Todos os avisos de terceiros, com o texto integral das licenças: **[NOTICE.md](NOTICE.md)**.

## Contribuindo

Issues e pull requests são bem-vindos em https://github.com/anisotton/opengym. Ao contribuir, você
concorda que sua contribuição seja licenciada sob a [GNU AGPL v3.0](LICENSE). Melhorias que não são
específicas do balé podem ser mais úteis no [projeto original](https://github.com/DuarteSantos8/openGym)
— considere enviá-las para lá também.
