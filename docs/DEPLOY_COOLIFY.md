# Publicar no Coolify (fit.brilhart.com.br)

Roteiro para publicar esta app no Coolify, pensado para o Anderson executar sozinho, sem
ajuda de agente — nenhum agente acessa o Coolify, o DNS, a Stripe de produção ou o servidor
de produção (decisão registrada na ISO-1391, 18/10).

**Antes de tudo: sem dados reais.** O backup (ISO-1399) continua adiado — vai ser tratado
junto com o backup de todas as aplicações do servidor. Até a ISO-1401 aprovar, este ambiente
usa **só contas de teste**, sem usuárias reais e sem chaves live (nem Stripe, nem e-mail de
produção). Trate esta primeira publicação como um ambiente de staging com domínio público.

Nenhum segredo real deve ir para este arquivo, para o repositório, ou para um comentário na
issue. As tabelas abaixo dizem onde cada valor vem de, não o valor em si.

## 1. Projeto no Coolify

1. Novo recurso → **Docker Compose** → aponte para o `docker-compose.yml` da branch
   `release/0.0.0-alpha` do fork `anisotton/opengym` (não o `DuarteSantos8/openGym` upstream —
   é o fork que tem o `/api/health` com banco, ISO-1400). Desde o merge do openGym v1.4.2
   (25/10/2026) a mídia dos exercícios vem dentro da imagem `web` (`catalogue/media`, licença
   Gym visual em `catalogue/media/NOTICE.md` — a passar pelo advogado antes do lançamento pago);
   não há mais serviço nem profile `media`.
2. Volumes persistentes — confirme que os dois sobrevivem a um redeploy:
   - `pgdata` (volume nomeado do `db`, dados de PostgreSQL).
   - `./data` (bind mount do `api` — contas, passkeys, `secret`, `vapid.json`, uploads).
     O Coolify precisa continuar montando o mesmo diretório do host a cada deploy; se ele
     oferecer "Persistent Storage" por serviço, aponte para o caminho que já existe, não para
     um novo.
3. **Exatamente uma réplica do `api`.** Não ligue autoscaling nem múltiplas réplicas nesse
   serviço: os desafios de WebAuthn em curso, os limites de tentativa de senha/código e os
   timers do Coach ficam em memória do processo (ver `api/server.js` e `api/coach/`), não em
   Postgres nem em Redis. Uma segunda réplica faria metade dos logins e das tentativas
   caírem num processo que nunca viu o desafio ou o contador — falhas intermitentes, difíceis
   de reproduzir. O `web` (nginx) pode ter quantas réplicas quiser; só o `api` é restrito a uma.
4. Build: nada além do que já está no
   `docker-compose.yml` — não é preciso `API_TARGET=coach` (isso ligaria o runtime do Coach, e
   o Coach fica desligado nesta fase, item 2 abaixo).

## 2. Variáveis de ambiente

Confira cada nome contra `.env.example` e o código antes de publicar — nenhuma variável aqui
deve estar ausente do `.env.example`, e nenhuma obrigatória deve faltar na tabela.

| Variável | Valor esperado / origem | Segredo? |
|---|---|---|
| `RP_ID` | `fit.brilhart.com.br` — hostname exato, sem `https://`, sem porta, sem barra final | Não |
| `ORIGIN` | `https://fit.brilhart.com.br` | Não |
| `APP_URL` | `https://fit.brilhart.com.br` (mesmo valor de `ORIGIN`; só precisa ser diferente se a API responder num endereço público diferente do `web`) | Não |
| `RP_NAME` | `Brilhart Fitness` — nome mostrado no diálogo de passkey do sistema | Não |
| `ALLOW_GUEST` | `0` — remove "Continuar sem conta"; instância de uso identificado, não anônimo | Não |
| `INVITE_ONLY` | `0` por enquanto (beta fechado controla quem convida de outro jeito); revisitar quando o controle de convites for decidido | Não |
| `PASSWORD_LOGIN` | `0` — passkey é o único jeito de entrar nesta fase | Não |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | gere a senha com `openssl rand -base64 24` (ou o gerador do Coolify); usuário/banco podem ficar `opengym`/`opengym` | `POSTGRES_PASSWORD` é segredo |
| `DATABASE_URL` | **não defina** — o próprio `docker-compose.yml` monta a partir dos três `POSTGRES_*` acima, apontando para o serviço `db` | — |
| `MAIL_PROVIDER` | deixe **sem definir** por enquanto (ver "Sem dados reais" acima) — sem provedor, e-mails de confirmação/recuperação vão só para o log do container; o Anderson decide o provedor de produção depois | Não |
| `MAIL_API_KEY` / `MAIL_FROM` | só quando `MAIL_PROVIDER` for ligado — ver `docs/SELF_HOSTING.md` ("Verificação de e-mail") | `MAIL_API_KEY` é segredo |
| `STRIPE_API_KEY` | chave **restrita** (`rk_...`) do Dashboard Stripe — **sandbox primeiro** (Developers → API keys, modo de teste) | Segredo |
| `STRIPE_WEBHOOK_SECRET` | gerado ao criar o endpoint de webhook no passo 4 | Segredo |
| `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_QUARTERLY` / `STRIPE_PRICE_YEARLY` / `STRIPE_PRICE_INTRO` | saída de `cd api && STRIPE_API_KEY=rk_... npm run stripe:setup` contra a conta sandbox (ver `docs/SELF_HOSTING.md` §7) | Não (são ids de Price, públicos) |
| `ADMIN_UIDS` | **vazio no primeiro deploy.** Depois do primeiro cadastro de teste, copie o id em Settings → Conta → Account ID (ou `docker compose exec db psql -U opengym -c "SELECT id, name FROM users"`) e redeploy com esse id aqui | Não |
| `COACH_DISABLED` | `1` — trava o Coach desligado, independente do toggle do admin (`AdminCoach.jsx` mostra "Force-disabled by COACH_DISABLED" no lugar do toggle) | Não |
| `TRUST_PROXY` | **não toque** — já vem `1` por padrão no `docker-compose.yml` porque a API só é alcançada através do `web` | — |
| `FIRST_USER_ADMIN` | **não defina** — o primeiro perfil viraria admin e *owner* da instância; aqui o admin é escolhido por `ADMIN_UIDS` depois do primeiro cadastro (o primeiro id em `ADMIN_UIDS` é o owner, o único que nomeia e remove admins) | Não |
| `BASE_PATH` | **vazio** — a app é servida na raiz do domínio; só para quem a publica num subcaminho (`/gym`) | Não |
| `CONTENT_SECURITY_POLICY` | **não defina** — o padrão vem de `web/Dockerfile` e carrega o hash do script inline de `index.html`; um valor próprio que esqueça esse hash quebra idioma e direção no primeiro paint | Não |
| `ALLOWED_PRIVATE_IPS` | **não defina** — só para servidores de push em endereço privado (rede local); na VPS os endpoints de push são públicos | Não |

Variáveis que existem no `.env.example` mas **não entram aqui por enquanto**: `VAPID_SUBJECT`
(opcional, usa o padrão derivado de `ORIGIN`), `DEFAULT_LANG` (opcional, deixe a app detectar o
idioma do navegador), `AUDIT_*` (fica nos padrões — log ligado, sem IP), `SESSION_DAYS` (fica no
padrão de 90), `MEDIA_*` (ficam nos padrões do upload de fotos/vídeos de exercícios próprios),
`PROGRAM_*` (ficam nos padrões do catálogo de programas), `HEVY_API_KEY` (uso de desenvolvedor,
nunca em produção).

## 3. Domínio e HTTPS

1. DNS: crie um registro `A` (ou `CNAME`, conforme o Coolify pedir) de `fit.brilhart.com.br`
   apontando para o servidor Coolify na Contabo.
2. No recurso do Coolify, adicione o domínio `fit.brilhart.com.br` e emita o certificado
   (Let's Encrypt, automático pelo Coolify) — aponte para o serviço `web` (porta `WEB_PORT`,
   `8080` por padrão).
3. **Passkeys só funcionam com o `RP_ID` igual ao hostname exato do navegador.** Se o domínio
   mudar depois, toda passkey já registrada para de funcionar — contas teriam que se cadastrar
   de novo. Por isso, confirme `fit.brilhart.com.br` antes de qualquer cadastro de teste real.

## 4. Webhook da Stripe

1. No Dashboard Stripe (**modo sandbox**), Developers → Webhooks → **Add endpoint**.
2. URL exata: `https://fit.brilhart.com.br/api/billing/webhook`.
3. Eventos a assinar: exatamente os que `applyStripeEvent` trata em `api/billing.js` —
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
   `invoice.payment_failed`. Sem `customer.subscription.created`, a conversão do período intro
   R$ 1,99 para o preço cheio do plano nunca dispara; sem `invoice.paid`, a primeira cobrança
   cheia nunca fica registrada (`firstFullCharge`). Marcar só o preset "Billing" do Dashboard não
   basta — ele inclui `customer.subscription.trial_will_end`, que nenhum `case` trata (não há
   trial neste desenho, ver `docs/SELF_HOSTING.md` §7), e pode deixar de fora algum dos seis
   acima; confira a lista final contra esses seis nomes.
4. Depois de criar o endpoint, copie o **Signing secret** (`whsec_...`) mostrado uma vez e
   coloque em `STRIPE_WEBHOOK_SECRET` no Coolify, depois redeploy.
5. Para ver falhas: `docker compose logs api` (ou o painel de logs do Coolify para o serviço
   `api`) — o handler loga qualquer erro de verificação de assinatura ou de processamento do
   evento. O próprio Dashboard Stripe também mostra, por evento, se a entrega teve 200 ou erro,
   e deixa reenviar manualmente.

## 5. Monitoramento

1. **Coolify:** ative a notificação nativa (e-mail, Discord, Slack — o que o Coolify oferecer)
   para quando um container ficar *unhealthy* ou parar. O `api` já tem `HEALTHCHECK` apontando
   para `/api/health` (`api/Dockerfile`) — com o banco fora, o healthcheck falha e o Coolify
   detecta.
2. **Monitor externo de uptime:** configure um serviço de uptime (UptimeRobot, Better Uptime, o
   que já for usado para outras apps da Contabo) para fazer `GET` em
   `https://fit.brilhart.com.br/api/health` a cada poucos minutos, esperando `200` com
   `{"ok":true,"db":"ok"}`. Um `503` (`{"ok":false,"db":"down"}`) ou timeout dispara o alerta.
3. **Canal do alerta:** escolha do Anderson (e-mail, Slack, WhatsApp…) — não há decisão tomada
   aqui, só o requisito de que algum canal receba os dois alertas acima.

## 6. Checklist pós-deploy

Marque cada item depois do primeiro deploy:

- [ ] HTTPS válido em `https://fit.brilhart.com.br` (cadeado verde, sem aviso de certificado)
- [ ] Cadastro de um perfil de teste com passkey num celular real (não um emulador) — a
      passkey precisa funcionar fim a fim no hostname público
- [ ] Login com essa mesma passkey num segundo acesso
- [ ] `curl https://fit.brilhart.com.br/api/health` → `200` com `{"ok":true,"db":"ok"}`
- [ ] Em **Settings → Admin** (com o seu uid em `ADMIN_UIDS`), o Coach aparece como
      indisponível / forçado desligado — não é possível ligá-lo pelo toggle
- [ ] Evento de teste disparado do Dashboard Stripe sandbox (**Send test webhook**) chega e
      aparece como entregue com sucesso no Dashboard e sem erro no log do `api`
- [ ] Parar o serviço `db` por alguns minutos (`docker compose stop db` ou o equivalente no
      Coolify) e confirmar que **os dois** alertas disparam: o do Coolify (container/health do
      `api` ficando unhealthy) e o do monitor externo de uptime (`/api/health` em 503/timeout).
      Depois, religar o `db` e confirmar que o `api` volta a reportar saudável sem precisar de
      restart manual.

## 7. Redeploy e rollback

- **Publicar um SHA novo** (por exemplo, o texto final dos termos de uso, ISO-1521/ISO-1522):
  dê push na branch que o Coolify acompanha (`release/0.0.0-alpha` do fork
  `anisotton/opengym`) e use o botão **Redeploy** do Coolify, ou deixe o webhook automático do
  Coolify disparar no push, se já estiver configurado. O Coolify reconstrói `web` e `api` a
  partir do `docker-compose.yml` dessa branch; `pgdata` e `./data` não são tocados.
- **Voltar à versão anterior:** no Coolify, a aba de *Deployments* do recurso lista cada deploy
  por commit — escolha o deploy anterior e use **Redeploy this version** (ou o equivalente —
  "Rollback" em versões recentes do Coolify). Como o `api` só tem uma réplica e os dados ficam
  em `pgdata`/`./data`, voltar uma versão de código não perde contas nem histórico — só desfaz
  a mudança de código. Uma migração de banco (`api/migrations/NNN_*.sql`) já aplicada por uma
  versão mais nova **não é desfeita** automaticamente ao voltar o código; isso só é um problema
  se o rollback cruzar uma migração que mudou o formato de uma tabela que a versão antiga lê de
  outro jeito — confirme pelo changelog da branch antes de descartar essa possibilidade.
