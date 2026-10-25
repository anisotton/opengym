# Termos de Uso, Política de Privacidade e aceite com versão — design (ISO-1390, Fase 4)

Data: 2026-10-17. Branch: `feat/ISO-1390-termos-privacidade`, a partir de `release/0.0.0-alpha`.
Push só para o fork `anisotton/opengym`; merge `--no-ff` na release pelo fluxo Oráculo/Sentinel.

## Intenção

Deixar o Brilhart Fitness em condições de ser vendido: a pessoa lê e aceita Termos de Uso e
Política de Privacidade no cadastro, a conta guarda **qual versão** foi aceita e **quando**, e
contas antigas aceitam a versão vigente no próximo acesso. Os textos ficam publicados dentro do
app, abertos sem login. Isso fecha o item "Termos de uso e política de privacidade" da ISO-1390.
Os textos são redigidos a partir do briefing jurídico do Nolc (documento `briefing-juridico` da
ISO-1390) e das decisões da ISO-1386; a revisão por advogado continua fora dos agentes e é
pré-requisito do lançamento pago, não deste trabalho.

## Decisões do Anderson

- A **fornecedora do serviço e controladora dos dados é a Brilhart Escola** (não a Isotton). A
  Isotton aparece como desenvolvedora e operadora técnica.
- Entregar os três pedaços juntos: os documentos, as páginas no app e o aceite no cadastro com
  versão gravada na conta.

## Fatos já decididos que os textos refletem (ISO-1386, briefing)

- Assinatura individual via Stripe: mensal R$ 89, trimestral R$ 237, anual R$ 768; primeiro mês
  R$ 1,99 em qualquer plano; e-mail de aviso antes da primeira cobrança cheia. Mensal cancela a
  qualquer momento; trimestral e anual seguem até o fim do período pago. Arrependimento em 7 dias
  (CDC art. 49).
- Dados tratados: nome, e-mail, data de nascimento, passkeys (chave pública), senha (hash, só se o
  instance ligar), treinos/cargas/rotinas/peso corporal (tratados como potencial dado de saúde),
  fotos e vídeos anexados a treinos, IDs e status da assinatura (cartão fica na Stripe),
  inscrição de push, log de segurança (90 dias ou 5 mil eventos, sem IP por padrão), um cookie de
  sessão assinado. Sem rastreadores nem cookies de marketing.
- Operadores: Stripe (pagamentos), provedor de e-mail transacional, hospedagem (Coolify).
  Coach/IA: cláusula condicional ("quando o recurso estiver ativado nesta instância…"), porque a
  decisão de ligar no lançamento está pendente.
- Menores: sem bloqueio; serviço destinado a maiores de 18; menores só com autorização do
  responsável, que é quem contrata. Menores de 12: o texto exige consentimento do responsável.
- Direitos do titular já atendidos no produto: exportação (JSON/ZIP) e exclusão da conta pelo app
  (apaga estado, mídias, passkeys, sessões e cliente Stripe; a Stripe guarda os registros fiscais
  dela). A equipe não vê histórico de treinos no painel admin.
- Conteúdo: código AGPL-3.0 com link para o fonte no app; textos de exercícios MIT; imagens/GIFs de
  exercícios são de terceiros com direitos reservados.

## Lacunas que ficam marcadas no texto como `[CONFIRMAR]`

Mesma convenção do site institucional (`config/brilhart.php`): o valor entre colchetes precisa ser
preenchido antes do deploy em produção. Um teste no frontend **não** falha por causa deles (são
texto), mas o checklist de go-live da Fase 5 deve listar a remoção.

- Razão social e CNPJ da Brilhart Escola.
- E-mail do canal de privacidade/encarregado. Chute do autor: `privacidade@brilhart.com.br`.
- Local da hospedagem (país/provedor do servidor Coolify).

Calls do autor (não decididos pelo Anderson, podem ser trocados sem mexer no desenho):
- Foro: comarca de São Leopoldo/RS (sede da escola), sem prejuízo do foro do consumidor.
- Contato geral: `atendimento@brilhart.com.br` e WhatsApp (51) 2165-8600, que já estão públicos.
- Endereço: R. João Neves da Fontoura, 532, Sala 305, Centro, São Leopoldo/RS, 93010-050.
- Versão inicial dos dois documentos: `2026-10-17` (a versão é a data de vigência, formato ISO,
  uma só para os dois textos; mudou um, muda a versão).

## Goals / non-goals / anti-goals

Goals
- Dois textos completos em pt-BR, com versão e data, legíveis no celular.
- Cadastro novo não acontece sem aceite explícito (checkbox, não pré-marcado).
- `users` guarda versão aceita e instante do aceite; `GET /api/me` diz se falta aceitar.
- Conta antiga (ou versão nova dos textos) é levada a aceitar no próximo acesso online.
- Links para os dois textos em Configurações, com a data em que a pessoa aceitou.
- Tudo testado: API (`node --test`, com Postgres) e app (vitest), 16 locales em sincronia.

Non-goals
- Tradução dos documentos jurídicos: ficam só em pt-BR (os rótulos da interface, sim, vão para os
  16 idiomas, porque `check-locales` exige).
- Histórico de todas as versões aceitas por conta (basta a última; o audit.log registra o evento).
- Página pública fora do app (site institucional) — pode linkar para a do app depois.
- Revisão jurídica, CNPJ, canal de privacidade: dependem de pessoas.

Anti-goals
- Bloquear o uso offline do app por causa do aceite: o app é offline-first; o bloqueio só vale
  quando há sessão com o servidor e a resposta de `/api/me` diz que falta aceitar.
- Dependência nova em `api/` ou `frontend/` (regra do CONTRIBUTING): nada de renderizador de
  markdown. O texto vive como módulo JS estruturado.
- Aceitar "em nome" da pessoa (pré-marcado, ou gravar aceite só por ter aberto o app).

## Desenho

### Fonte dos textos

- `frontend/src/legal/version.js` exporta `LEGAL_VERSION = '2026-10-17'`.
- `frontend/src/legal/termos-de-uso.js` e `frontend/src/legal/politica-de-privacidade.js`
  exportam `{ id, title, version, sections: [{ heading, paragraphs: [string | {list:[...]}] }] }`.
  Texto em pt-BR, sem markdown, sem HTML; parágrafos são strings, listas são arrays. O render é
  um componente simples (`<h2>`, `<p>`, `<ul>`).
- `api/legal.js` exporta a mesma constante `LEGAL_VERSION`. Um teste vitest em
  `frontend/src/legal/version.test.js` importa `../../../api/legal.js` e exige igualdade, para as
  duas cópias não divergirem.
- `frontend/scripts/legal-export.mjs` escreve os dois textos como `.md` em `docs/legal/` (com
  cabeçalho de versão) para mandar ao jurídico; `docs/legal/*.md` é gerado e commitado, com uma
  linha no topo avisando que a fonte é o módulo JS. (Call do autor: gerar e commitar, para o
  advogado não precisar de Node.)

### Banco (`api/migrations/006_legal_acceptance.sql`)

```sql
ALTER TABLE users ADD COLUMN terms_accepted_version text;
ALTER TABLE users ADD COLUMN terms_accepted_at timestamptz;
```

`store.js`: `createUser` grava os dois campos quando vierem; `rowToUser` expõe
`termsAcceptedVersion`/`termsAcceptedAt`; nova `setTermsAccepted(pool, uid, version, at)`.
`upsertUser`/import ficam como estão (contas importadas não têm aceite, e é isso que as leva ao
sheet de aceite).

### API (`api/server.js`, `api/openapi.yaml`)

- `GET /api/config` passa a devolver `legal_version` (público: a tela de cadastro lê antes do
  login).
- `POST /api/register/options` exige `termsVersion === LEGAL_VERSION`; sem isso, `400
  { code: 'terms-required' }`. A versão vai no challenge e `POST /api/register/verify` grava na
  conta criada (mesma transação que já cria usuário, consome convite e insere a passkey).
  `POST /api/register/password` (só com `PASSWORD_LOGIN`) segue a mesma regra.
- `POST /api/account/terms/accept` `{ version }`: sessão obrigatória; `version` precisa ser a
  vigente (`400 { code: 'terms-version-stale' }` caso contrário); grava versão e `now()`; audita
  `account.terms.accept`. Idempotente. Entra no rate-limit compartilhado como as rotas de conta.
- `GET /api/me` ganha `termsVersion` (aceita, ou null), `termsAcceptedAt` (ISO, ou null) e
  `needsTerms` (aceita !== vigente). Vêm sempre, inclusive em `PASSWORD_LOGIN`. O login por senha
  (`PasswordAuth.signedIn`) passa a refazer `/api/me` como o login por passkey já faz, para o sheet
  abrir no mesmo momento nos dois caminhos.
- Enquanto o sheet de aceite estiver aberto, o lembrete de `needsEmail` e o resgate de device-link
  esperam (um prompt de cada vez).
- Sincronização (`PUT /api/data` e afins) **não** passa a exigir aceite: o app é offline-first e
  quem ainda não aceitou não pode perder treino por isso. O bloqueio geral é no app (sheet
  travado).
- **Exceção: `POST /api/billing/checkout` exige aceite da versão vigente** e responde
  `403 { code: 'terms-required' }` quando falta, ao lado do `email-unverified` que já existe ali.
  É onde o contrato pago se forma e é sempre online, então o argumento do offline não vale; sem
  isso um cliente desatualizado (PWA em cache, APK pareado) abriria o checkout sem nunca ter
  aceitado. `views/SettingsPlan.jsx` trata o código novo abrindo o sheet de aceite. (Call do
  autor, levantado pelo builder check.)
- **Versão aceita = versão do texto que o cliente consegue mostrar.** O app envia sempre o
  `LEGAL_VERSION` do próprio bundle, nunca o de `/api/config`; o servidor recusa versão diferente
  da vigente com `400 { code: 'terms-version-stale' }`. Um cliente com bundle antigo, portanto,
  não consegue "aceitar" um texto que não consegue ler: o sheet mostra "Atualize o app para
  aceitar os novos termos" (e, no PWA, oferece recarregar). `legal_version` em `/api/config`
  continua existindo só para o app saber que está desatualizado antes mesmo de tentar. (Call do
  autor; a alternativa, servir o texto pela API, muda onde o jurídico edita e é bem mais trabalho.)
- `openapi.yaml` documenta a rota nova e os campos novos (`openapi-routes.test.js` exige).

### App

- Rotas `#/termos` e `#/privacidade` (`views/Legal.jsx`, um componente parametrizado), renderizadas
  antes do branch autenticado/Login em `App.jsx`, igual a `EmailVerify`. Cabeçalho com a marca,
  título, "Versão 2026-10-17", seções, botão voltar. Largura de leitura confortável no celular.
- `SignupFlow.jsx` (passkey) e `PasswordRegisterForm` (senha): checkbox desmarcado "Li e aceito os
  Termos de Uso e a Política de Privacidade" (componente comum `TermsCheckbox`). Botão de criar
  fica desabilitado até marcar. `lib/api.js` `passkeyRegister`/`passwordRegister` passam
  `termsVersion = LEGAL_VERSION` do bundle.
- **Ler os textos sem perder o lugar:** os links do checkbox e do sheet de aceite abrem o texto num
  **sheet empilhado por cima** (`openSheet` já suporta pilha), com botão fechar, em todas as
  plataformas. Nova aba não serve: o sheet de aceite é travado e cobriria a rota `#/termos` na
  mesma aba, e no shell Capacitor não existe aba nem URL pública para uma rota hash do bundle.
  As rotas `#/termos` e `#/privacidade` continuam existindo para link direto e compartilhamento.
  (Call do autor, levantado pelo builder check.)
- Conta com `needsTerms`: `openSheet(..., { locked: true })` com título "Atualizamos nossos
  termos", resumo de uma linha, os dois links e um botão "Aceitar e continuar" que chama
  `POST /api/account/terms/accept` e atualiza `user` no store. Só abre com `user` presente e
  online; não abre em guest/demo; reabre se a pessoa recarregar sem aceitar. Nenhum botão de
  fechar.
- Configurações: no bloco "Sobre"/rodapé onde já aparece a versão e o AGPL, duas linhas com os
  links e, se houver aceite, "Você aceitou a versão X em dd/mm/aaaa".
- Strings novas da interface em `pt-BR`, `pt` e nos outros 14 locales (`check-locales`).

### Conteúdo dos documentos (estrutura)

Termos de Uso: 1 Quem somos e o que é o serviço · 2 Conta, passkeys e e-mail · 3 Idade mínima e
responsáveis · 4 Assinatura, preços, primeiro mês, renovação · 5 Cancelamento, arrependimento e
reembolso · 6 Uso aceitável e suas obrigações · 7 Conteúdo, licenças e propriedade intelectual
(AGPL, textos MIT, imagens de terceiros, suas fotos) · 8 Aviso de saúde (o app não substitui
orientação profissional) · 9 Disponibilidade, mudanças e encerramento · 10 Responsabilidade ·
11 Alterações destes termos e versão · 12 Lei, foro e contato.

Política de Privacidade: 1 Controladora e contato · 2 Dados que tratamos e por quê (tabela por
finalidade e base legal) · 3 Dados de saúde (treinos, peso) · 4 Menores de idade · 5 Com quem
compartilhamos (operadores, transferência internacional) · 6 Cookies e armazenamento local ·
7 Notificações push · 8 Por quanto tempo guardamos · 9 Seus direitos e como exercer (exportar,
excluir pelo app, canal de privacidade, ANPD) · 10 Segurança · 11 Coach/IA (condicional) ·
12 Alterações e versão.

## Testes

- API: migração aplica; `register/options` sem `termsVersion` → 400; com versão errada → 400;
  com versão certa → conta criada com `terms_accepted_*`; `account/terms/accept` grava, rejeita
  versão antiga, exige sessão; `/api/me` reflete `needsTerms`/`termsAcceptedAt` antes e depois;
  `/api/config` expõe `legal_version`; `billing/checkout` → 403 `terms-required` sem aceite e
  passa com aceite; openapi cobre a rota e os códigos novos.
- App: `Legal.test.jsx` (renderiza seções e versão das duas páginas); `SignupFlow` (botão
  desabilitado até marcar, envia `termsVersion`, link abre o texto empilhado); sheet de aceite
  (abre com `needsTerms`, não abre offline/guest, aceitar chama a API e fecha, versão stale mostra
  "atualize o app"); `SettingsPlan` trata `terms-required`; `version.test.js` (constante igual à
  da API); `locale-coverage`/`check-locales` passam.

## O que fica para quem implementa

- Nomes exatos de chaves i18n, classes CSS e posição no Settings.
- Redação final dos parágrafos dentro da estrutura acima (pt-BR, voz da marca: direta, segunda
  pessoa, sem juridiquês onde dá; títulos curtos).
- Como o `PasswordRegisterForm` compartilha o checkbox com o `SignupFlow` (componente comum
  `TermsCheckbox` é o caminho óbvio).

## Fora deste trabalho (mesma issue ISO-1390)

- Mídia própria dos exercícios e esclarecimento de licença com a AscendAPI.
- Revisão jurídica e preenchimento dos `[CONFIRMAR]`.
