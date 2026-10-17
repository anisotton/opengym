# Termos de Uso, Política de Privacidade e aceite com versão — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** publicar os dois textos legais dentro do app, exigir aceite explícito no cadastro e gravar na conta qual versão foi aceita e quando, levando contas antigas a aceitar no próximo acesso online.

**Architecture:** os textos vivem como módulos JS estruturados em `frontend/src/legal/` com uma constante de versão duplicada em `api/legal.js` (um teste garante igualdade). A API grava `terms_accepted_version`/`terms_accepted_at` em `users`, exige a versão vigente no cadastro e no checkout, e expõe `needsTerms` em `/api/me`. O app mostra os textos em rotas públicas e num sheet empilhado, bloqueia o cadastro atrás de um checkbox e abre um sheet travado para quem precisa aceitar.

**Tech Stack:** React 19 + Vite + Zustand + vitest/happy-dom (frontend); Node `node:http` sem framework + `pg` + `node --test` (api). Nenhuma dependência nova.

**Spec:** `docs/superpowers/specs/2026-10-17-termos-privacidade-aceite-design.md`

## Global Constraints

- Branch `feat/ISO-1390-termos-privacidade`; push só para `git@github.com:anisotton/opengym.git`. Commits terminam com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Sem dependências novas em `api/` nem em `frontend/` (CONTRIBUTING). Nada de renderizador de markdown.
- Versão inicial dos dois textos: `'2026-10-17'` (string, formato de data ISO, uma só para ambos). Constante `LEGAL_VERSION` em `frontend/src/legal/version.js` e em `api/legal.js`, iguais.
- Textos legais só em pt-BR, sem markdown nem HTML dentro das strings. Lacunas marcadas literalmente como `[CONFIRMAR]`.
- Toda string nova da interface passa por `t()` e existe nos 16 packs de `frontend/src/locales/` (`node scripts/check-locales.mjs` tem de dizer "in sync"; o vitest `scripts/check-locales.test.mjs` roda na suíte).
- Toda rota nova ou campo novo da API é documentado em `api/openapi.yaml` (`api/test/openapi-routes.test.js`).
- Códigos de erro: `terms-required` (400 no cadastro, 403 no checkout), `terms-version-stale` (400). Evento de auditoria: `account.terms.accept`.
- Comentários de código e mensagens de commit em inglês, no estilo do repo (prefixos `feat(api):`, `feat(app):`, `test(app):`, `docs:`, sufixo `— ISO-1390`).
- Falhas de teste pré-existentes na release (não são deste trabalho): 10 testes do Coach em `api/test` (`coach-limits`, `jobs`, `payload`, `payload-bounds`, `routes`) e `server-password.test.js` "older parameters hash" (429). Qualquer outra falha é nossa.

## Review Focus

Entradas que a spec implica mas nenhum teste cobre sozinho; cada uma ganhou um teste na task dona:

1. **Conta importada de `db.json` no boot (`readBootDb`/`upsertUser`)** chega sem aceite e tem de ver `needsTerms: true` em `/api/me`, não um 500 por coluna nula — Task 6.
2. **`termsVersion` com tipo errado** (número, objeto, string vazia, só espaços) no cadastro responde 400 `terms-required`, nunca grava lixo — Task 6.
3. **Aceite repetido** (`POST /api/account/terms/accept` duas vezes) responde 200 e não muda `terms_accepted_at` da primeira vez — Task 7.
4. **Sheet de aceite com a rede caindo no meio**: o botão "Aceitar e continuar" falha, o sheet continua travado e mostra erro legível, sem fechar nem marcar aceito — Task 10.
5. **Guest/demo e usuário sem sessão** nunca veem o sheet travado, mesmo com `needsTerms` sobrando de um objeto antigo — Task 10.

## Ordem e paralelismo

Task 1 primeiro (todas dependem dela). Depois três frentes independentes em paralelo, cada uma sequencial por dentro porque editam os mesmos arquivos:

- **Frente A — textos:** Tasks 2, 3, 4 (só `frontend/src/legal/`, `frontend/scripts/`, `docs/legal/`).
- **Frente B — API:** Tasks 5, 6, 7 (só `api/`).
- **Frente C — app:** Tasks 8, 9, 10, 11 (só `frontend/src/` fora de `legal/`, mais `pt-BR.js`/`pt.js`).

Task 12 por último: os outros 14 locales, exportação final dos `.md`, suíte completa.

Enquanto a Frente A não termina, a Frente C importa `frontend/src/legal/termos-de-uso.js` e `politica-de-privacidade.js` pelo **contrato** abaixo; a Task 1 cria os dois arquivos com uma seção placeholder para o import não quebrar.

**Contrato de um documento legal** (`frontend/src/legal/*.js`):

```js
export default {
  id: 'termos' | 'privacidade',
  title: 'Termos de Uso' | 'Política de Privacidade',
  version: LEGAL_VERSION,
  sections: [{ heading: string, paragraphs: Array<string | { list: string[] }> }]
}
```

---

### Task 1: constante de versão e esqueleto dos módulos legais

**Files:**
- Create: `api/legal.js`
- Create: `frontend/src/legal/version.js`
- Create: `frontend/src/legal/termos-de-uso.js` (placeholder, Task 2 preenche)
- Create: `frontend/src/legal/politica-de-privacidade.js` (placeholder, Task 3 preenche)
- Test: `frontend/src/legal/version.test.js`

**Interfaces:**
- Produces: `export const LEGAL_VERSION = '2026-10-17'` em ambos os arquivos; os dois módulos de documento exportam default no contrato acima com `sections: [{ heading: 'Em preparação', paragraphs: ['Texto em preparação.'] }]`.

- [ ] **Step 1: escrever o teste que falha**

```js
// frontend/src/legal/version.test.js
import { describe, expect, it } from 'vitest'
import { LEGAL_VERSION } from './version.js'
import { LEGAL_VERSION as API_LEGAL_VERSION } from '../../../api/legal.js'
import termos from './termos-de-uso.js'
import privacidade from './politica-de-privacidade.js'

describe('LEGAL_VERSION', () => {
  it('is an ISO date and the API copy is identical', () => {
    expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(API_LEGAL_VERSION).toBe(LEGAL_VERSION)
  })
  it('both documents carry it and follow the contract', () => {
    for (const doc of [termos, privacidade]) {
      expect(doc.version).toBe(LEGAL_VERSION)
      expect(['termos', 'privacidade']).toContain(doc.id)
      expect(doc.title.length).toBeGreaterThan(0)
      for (const s of doc.sections) {
        expect(typeof s.heading).toBe('string')
        for (const p of s.paragraphs) expect(typeof p === 'string' || Array.isArray(p.list)).toBe(true)
      }
    }
  })
})
```

- [ ] **Step 2: rodar e ver falhar**

Run: `cd frontend && npx vitest run src/legal/version.test.js`
Expected: FAIL — "Failed to resolve import ./version.js".

- [ ] **Step 3: criar os quatro arquivos**

`api/legal.js`: comentário de uma linha dizendo que a cópia canônica da data é `frontend/src/legal/version.js` e que `version.test.js` as compara; `export const LEGAL_VERSION = '2026-10-17';`. Mesma coisa em `frontend/src/legal/version.js`. Os dois documentos importam `LEGAL_VERSION` e exportam o placeholder do contrato.

- [ ] **Step 4: rodar e ver passar**

Run: `cd frontend && npx vitest run src/legal/version.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: commit**

```bash
git add api/legal.js frontend/src/legal/
git commit -m "feat(legal): one LEGAL_VERSION for app and API, document module contract — ISO-1390"
```

---

### Task 2: Termos de Uso (texto)

**Files:**
- Modify: `frontend/src/legal/termos-de-uso.js`
- Test: `frontend/src/legal/termos-de-uso.test.js`

**Interfaces:**
- Consumes: contrato da Task 1.
- Produces: 12 seções com exatamente estes `heading`, nesta ordem:
  1. `Quem somos e o que é o serviço`
  2. `Conta, passkeys e e-mail`
  3. `Idade mínima e responsáveis`
  4. `Assinatura, preços, primeiro mês e renovação`
  5. `Cancelamento, arrependimento e reembolso`
  6. `Uso aceitável e suas obrigações`
  7. `Conteúdo, licenças e propriedade intelectual`
  8. `Aviso de saúde`
  9. `Disponibilidade, mudanças e encerramento`
  10. `Responsabilidade`
  11. `Alterações destes termos e versão`
  12. `Lei, foro e contato`

- [ ] **Step 1: escrever o teste que falha**

```js
// frontend/src/legal/termos-de-uso.test.js
import { describe, expect, it } from 'vitest'
import termos from './termos-de-uso.js'

const HEADINGS = ['Quem somos e o que é o serviço', 'Conta, passkeys e e-mail', 'Idade mínima e responsáveis',
  'Assinatura, preços, primeiro mês e renovação', 'Cancelamento, arrependimento e reembolso',
  'Uso aceitável e suas obrigações', 'Conteúdo, licenças e propriedade intelectual', 'Aviso de saúde',
  'Disponibilidade, mudanças e encerramento', 'Responsabilidade', 'Alterações destes termos e versão', 'Lei, foro e contato']
const flat = doc => doc.sections.flatMap(s => s.paragraphs.map(p => typeof p === 'string' ? p : p.list.join('\n'))).join('\n')

describe('Termos de Uso', () => {
  it('has the twelve sections of the design, in order', () => {
    expect(termos.id).toBe('termos')
    expect(termos.title).toBe('Termos de Uso')
    expect(termos.sections.map(s => s.heading)).toEqual(HEADINGS)
  })
  it('states the decided facts', () => {
    const text = flat(termos)
    for (const fact of ['Brilhart Escola', 'Isotton', 'R$ 89', 'R$ 237', 'R$ 768', 'R$ 1,99', '7 dias', 'art. 49',
      '18 anos', 'AGPL', 'MIT', 'São Leopoldo', 'atendimento@brilhart.com.br', '(51) 2165-8600', '[CONFIRMAR]'])
      expect(text, fact).toContain(fact)
  })
  it('has no markup inside the strings', () => {
    expect(flat(termos)).not.toMatch(/<[a-z]|\*\*|^#/m)
  })
})
```

- [ ] **Step 2: rodar e ver falhar**

Run: `cd frontend && npx vitest run src/legal/termos-de-uso.test.js`
Expected: FAIL no primeiro `it` (placeholder tem 1 seção).

- [ ] **Step 3: escrever o texto**

Voz da marca: direta, segunda pessoa ("você"), sem juridiquês onde dá, títulos curtos. Cada seção com 2–6 parágrafos; listas (`{ list: [...] }`) para preços, obrigações e licenças. Fatos obrigatórios por seção:

- §1: fornecedora Brilhart Escola — `[CONFIRMAR razão social]`, CNPJ `[CONFIRMAR]`, endereço R. João Neves da Fontoura, 532, Sala 305, Centro, São Leopoldo/RS, 93010-050; Isotton como desenvolvedora e operadora técnica; o que o app faz (registro de treinos, cargas, peso corporal).
- §2: conta com nome, e-mail confirmado por link e passkey; senha só quando a instância liga; responsabilidade por manter acesso ao e-mail e aos dispositivos.
- §3: destinado a maiores de 18; menor só com autorização do responsável, que é quem contrata; menor de 12 exige consentimento do responsável.
- §4: lista mensal R$ 89, trimestral R$ 237, anual R$ 768; primeiro mês R$ 1,99 em qualquer plano; e-mail de aviso antes da primeira cobrança cheia; pagamento via Stripe; renovação automática.
- §5: mensal cancela a qualquer momento; trimestral e anual seguem até o fim do período pago; arrependimento em 7 dias (CDC, art. 49) com reembolso integral; como cancelar (Configurações → Plano / portal Stripe).
- §6: uso pessoal, não compartilhar conta, não tentar burlar segurança, conteúdo enviado (fotos/vídeos) tem de ser seu.
- §7: código AGPL-3.0 com fonte em `https://github.com/anisotton/opengym`; textos de exercícios MIT (hasaneyldrm/exercises-dataset); imagens e GIFs de terceiros com direitos reservados (Gym visual); suas fotos continuam suas, licença limitada para exibir no app.
- §8: o app não substitui orientação de profissional de educação física ou de saúde; procure um médico antes de iniciar.
- §9: sem garantia de disponibilidade contínua; manutenção; pode encerrar conta por violação; você pode exportar e excluir pelo app.
- §10: limites de responsabilidade dentro do que o CDC permite; sem responsabilidade por lesão decorrente de uso inadequado.
- §11: versão identificada pela data (a atual é `LEGAL_VERSION`, interpolada no texto como `Versão ${LEGAL_VERSION}`); mudança relevante exige novo aceite no próximo acesso; versão aceita fica registrada na conta.
- §12: lei brasileira; foro de São Leopoldo/RS, sem prejuízo do foro do consumidor; contato atendimento@brilhart.com.br e WhatsApp (51) 2165-8600.

- [ ] **Step 4: rodar e ver passar**

Run: `cd frontend && npx vitest run src/legal/`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add frontend/src/legal/termos-de-uso.js frontend/src/legal/termos-de-uso.test.js
git commit -m "feat(legal): Termos de Uso, version 2026-10-17 — ISO-1390"
```

---

### Task 3: Política de Privacidade (texto)

**Files:**
- Modify: `frontend/src/legal/politica-de-privacidade.js`
- Test: `frontend/src/legal/politica-de-privacidade.test.js`

**Interfaces:**
- Produces: 12 seções com estes `heading`, nesta ordem:
  1. `Controladora e contato`
  2. `Dados que tratamos e por quê`
  3. `Dados de saúde`
  4. `Menores de idade`
  5. `Com quem compartilhamos`
  6. `Cookies e armazenamento local`
  7. `Notificações push`
  8. `Por quanto tempo guardamos`
  9. `Seus direitos e como exercer`
  10. `Segurança`
  11. `Coach com inteligência artificial`
  12. `Alterações e versão`

- [ ] **Step 1: escrever o teste que falha** — mesmo formato da Task 2 (`politica-de-privacidade.test.js`), com `id` `'privacidade'`, `title` `'Política de Privacidade'`, a lista de headings acima e estes fatos: `'Brilhart Escola'`, `'Isotton'`, `'LGPD'`, `'Stripe'`, `'Coolify'`, `'privacidade@brilhart.com.br'`, `'90 dias'`, `'5 mil'`, `'ANPD'`, `'passkey'`, `'12 anos'`, `'18 anos'`, `'exportar'`, `'excluir'`, `'[CONFIRMAR]'`. Mesmo teste de "no markup".

- [ ] **Step 2: rodar e ver falhar**

Run: `cd frontend && npx vitest run src/legal/politica-de-privacidade.test.js`
Expected: FAIL.

- [ ] **Step 3: escrever o texto** — fatos obrigatórios por seção:

- §1: controladora Brilhart Escola (`[CONFIRMAR razão social]`, CNPJ `[CONFIRMAR]`, endereço da Task 2); Isotton como operadora técnica; canal de privacidade/encarregado `privacidade@brilhart.com.br [CONFIRMAR]`.
- §2: lista, um item por dado no formato "Dado — para quê — base legal (LGPD)": nome; e-mail; data de nascimento; passkeys (só a chave pública); senha (hash, só se a instância ligar); treinos, cargas, rotinas e peso corporal; fotos e vídeos anexados a treinos; IDs e status da assinatura (o cartão fica na Stripe); inscrição de notificações push; log de segurança; cookie de sessão assinado. Sem rastreadores nem cookies de marketing.
- §3: treinos e peso tratados como potencial dado de saúde (dado sensível, LGPD art. 11); a equipe não vê histórico de treinos no painel admin.
- §4: serviço para maiores de 18; menores só com autorização do responsável; menores de 12 anos só com consentimento específico do responsável.
- §5: operadores Stripe (pagamentos), provedor de e-mail transacional, hospedagem via Coolify em `[CONFIRMAR local/provedor]`; transferência internacional quando o operador estiver fora do Brasil, com as garantias da LGPD.
- §6: um cookie de sessão assinado; estado do app em `localStorage` do próprio dispositivo; nada de rastreamento.
- §7: push opcional, inscrição guardada por dispositivo, removível nas configurações do navegador ou do app.
- §8: dados da conta enquanto ela existir; log de segurança 90 dias ou 5 mil eventos (sem IP por padrão); registros fiscais ficam com a Stripe pelo prazo legal.
- §9: exportar (JSON/ZIP) e excluir a conta pelo próprio app (apaga estado, mídias, passkeys, sessões e cliente Stripe); demais direitos LGPD pelo canal de privacidade; reclamação à ANPD.
- §10: passkeys, HTTPS, cookie assinado, senha com hash, sessão revogável por dispositivo.
- §11: cláusula condicional — "quando o recurso estiver ativado nesta instância", resumo de treinos enviado a um provedor de IA, com consentimento próprio dentro do app e possível desligar.
- §12: versão pela data (`Versão ${LEGAL_VERSION}`), novo aceite quando mudar de forma relevante.

- [ ] **Step 4: rodar e ver passar**

Run: `cd frontend && npx vitest run src/legal/`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add frontend/src/legal/politica-de-privacidade.js frontend/src/legal/politica-de-privacidade.test.js
git commit -m "feat(legal): Política de Privacidade, version 2026-10-17 — ISO-1390"
```

---

### Task 4: exportação em Markdown para o jurídico

**Files:**
- Create: `frontend/scripts/legal-export.mjs`
- Create: `docs/legal/termos-de-uso.md`, `docs/legal/politica-de-privacidade.md` (gerados)
- Test: `frontend/scripts/legal-export.test.mjs`

**Interfaces:**
- Produces: `export function renderMarkdown(doc) -> string`; `export const OUT_DIR` (caminho absoluto de `docs/legal/`); `export const TARGETS = [[termos, 'termos-de-uso.md'], [privacidade, 'politica-de-privacidade.md']]`. Executado diretamente (`node scripts/legal-export.mjs`), escreve os dois arquivos.

- [ ] **Step 1: escrever o teste que falha**

```js
// frontend/scripts/legal-export.test.mjs
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderMarkdown, OUT_DIR, TARGETS } from './legal-export.mjs'

describe('legal-export', () => {
  it('renders title, version line, headings, paragraphs and lists', () => {
    const md = renderMarkdown({ id: 'x', title: 'T', version: '2026-10-17',
      sections: [{ heading: 'H', paragraphs: ['p1', { list: ['a', 'b'] }] }] })
    expect(md.split('\n')[0]).toMatch(/^<!-- Gerado por frontend\/scripts\/legal-export\.mjs/)
    expect(md).toContain('\n# T\n')
    expect(md).toContain('Versão: 2026-10-17')
    expect(md).toContain('\n## H\n')
    expect(md).toContain('\np1\n')
    expect(md).toContain('\n- a\n- b\n')
  })
  it('the committed docs/legal/*.md are what the modules render now', () => {
    for (const [doc, file] of TARGETS)
      expect(readFileSync(join(OUT_DIR, file), 'utf8'), file).toBe(renderMarkdown(doc))
  })
})
```

- [ ] **Step 2: rodar e ver falhar**

Run: `cd frontend && npx vitest run scripts/legal-export.test.mjs`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: implementar o script**

Primeira linha do `.md`: `<!-- Gerado por frontend/scripts/legal-export.mjs a partir de frontend/src/legal/*.js — edite o módulo JS e rode o script; não edite este arquivo. -->`. Depois `# {title}`, linha `Versão: {version}`, e por seção `## {heading}` seguido dos parágrafos (string → parágrafo; `{list}` → `- item`). Linhas em branco entre blocos. Só executa a escrita quando `process.argv[1]` resolve para o próprio arquivo (`fileURLToPath(import.meta.url)`), para o teste importar sem efeito colateral.

- [ ] **Step 4: gerar os arquivos e rodar os testes**

Run: `cd frontend && node scripts/legal-export.mjs && npx vitest run scripts/legal-export.test.mjs`
Expected: dois arquivos em `docs/legal/`; PASS.

- [ ] **Step 5: commit**

```bash
git add frontend/scripts/legal-export.mjs frontend/scripts/legal-export.test.mjs docs/legal/
git commit -m "docs(legal): Markdown export of the two legal texts for legal review — ISO-1390"
```

---

### Task 5: migração 006 e `store.js`

**Files:**
- Create: `api/migrations/006_legal_acceptance.sql`
- Modify: `api/store.js` (`rowToUser` L67, `createUser` L113)
- Test: `api/test/store-terms.test.js`

**Interfaces:**
- Produces: colunas `users.terms_accepted_version text`, `users.terms_accepted_at timestamptz`; `rowToUser` expõe `termsAcceptedVersion` (string) e `termsAcceptedAt` (ISO string) só quando presentes, como `emailVerifiedAt`; `createUser(pool, user)` grava `user.termsAcceptedVersion`/`user.termsAcceptedAt` quando vierem; nova `export async function setTermsAccepted(pool, id, version, at)` que grava os dois campos.

- [ ] **Step 1: escrever o teste que falha**

```js
// api/test/store-terms.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, runMigrations } from '../db.js';
import { createUser, getUserById, setTermsAccepted } from '../store.js';
import { provisionTestDatabase } from './helpers.mjs';

async function withDb(fn) {
  const { databaseUrl, cleanup } = await provisionTestDatabase();
  const pool = createPool(databaseUrl);
  try { await runMigrations(pool); await fn(pool); } finally { await pool.end(); await cleanup(); }
}

test('migration 006: a user created with an acceptance reads it back', async () => {
  await withDb(async pool => {
    const at = '2026-10-17T12:00:00.000Z';
    await createUser(pool, { id: 'u_t1', name: 'T', created: at, termsAcceptedVersion: '2026-10-17', termsAcceptedAt: at });
    const u = await getUserById(pool, 'u_t1');
    assert.equal(u.termsAcceptedVersion, '2026-10-17');
    assert.equal(u.termsAcceptedAt, at);
  });
});

test('a user created without one has neither field, and setTermsAccepted fills both', async () => {
  await withDb(async pool => {
    await createUser(pool, { id: 'u_t2', name: 'T', created: new Date().toISOString() });
    const before = await getUserById(pool, 'u_t2');
    assert.ok(!('termsAcceptedVersion' in before) && !('termsAcceptedAt' in before));
    await setTermsAccepted(pool, 'u_t2', '2026-10-17', '2026-10-17T13:00:00.000Z');
    const after = await getUserById(pool, 'u_t2');
    assert.equal(after.termsAcceptedVersion, '2026-10-17');
    assert.equal(after.termsAcceptedAt, '2026-10-17T13:00:00.000Z');
  });
});
```

- [ ] **Step 2: rodar e ver falhar**

Precisa de um Postgres. Uma vez por sessão:
```bash
docker run -d --name tpg-1390 -e POSTGRES_USER=opengym -e POSTGRES_PASSWORD=opengym -p 127.0.0.1:54329:5432 postgres:17-alpine
export TEST_DATABASE_URL=postgresql://opengym:opengym@127.0.0.1:54329/postgres
```
Run: `cd api && node --test test/store-terms.test.js`
Expected: FAIL ("setTermsAccepted is not exported" / coluna inexistente).

- [ ] **Step 3: implementar**

Migração com comentário de cabeçalho no estilo de `004_stripe_customer.sql` (ISO-1390, por que duas colunas e não uma tabela de histórico: basta a última versão, o audit.log tem o evento) e os dois `ALTER TABLE users ADD COLUMN`. `createUser` ganha as duas colunas no INSERT (`user.termsAcceptedVersion || null`, `user.termsAcceptedAt || null`). `setTermsAccepted` é um `UPDATE users SET terms_accepted_version = $2, terms_accepted_at = $3 WHERE id = $1`.

- [ ] **Step 4: rodar e ver passar**

Run: `cd api && node --test test/store-terms.test.js test/db-migrations.test.js`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add api/migrations/006_legal_acceptance.sql api/store.js api/test/store-terms.test.js
git commit -m "feat(api): users.terms_accepted_version/_at, store.js read/write — ISO-1390"
```

---

### Task 6: cadastro exige a versão vigente; `/api/config` e `/api/me` a expõem

**Files:**
- Modify: `api/server.js` (`GET /api/config` L2158, `GET /api/me` L2209, `POST /api/register/options` L2226, `POST /api/register/verify` L2266, `POST /api/register/password` L1312)
- Modify: `api/openapi.yaml` (`/api/config` L207, `/api/me` L340, `/api/register/options`, `/api/register/password`)
- Modify: `api/test/server-config-session.test.js` (os quatro `deepEqual` em L45, L60, L71, L76 ganham `legal_version: '2026-10-17'`)
- Modify: `api/test/server-token-refresh.test.js` L64 (lista de chaves)
- Test: `api/test/server-terms.test.js`

**Interfaces:**
- Consumes: `LEGAL_VERSION` de `api/legal.js`; `createUser` com `termsAcceptedVersion`/`termsAcceptedAt` (Task 5).
- Produces:
  - `GET /api/config` → `legal_version: LEGAL_VERSION` (sempre, público, logo após `allow_guest`).
  - `GET /api/me` → além do que já devolve, `termsVersion: string|null`, `termsAcceptedAt: string|null`, `needsTerms: boolean` (`user.termsAcceptedVersion !== LEGAL_VERSION`), **sempre**, inclusive com `PASSWORD_LOGIN`; ordem das chaves: `user`, (campos de e-mail), `termsVersion`, `termsAcceptedAt`, `needsTerms`, (`token`).
  - Helper `function termsVersionProblem(body)` em server.js: devolve `null` quando `body.termsVersion === LEGAL_VERSION`; `{ status: 400, error: 'accept the terms to continue', code: 'terms-required' }` quando ausente, não-string ou vazia após trim; `{ status: 400, error: 'these terms are not the current ones — update the app', code: 'terms-version-stale' }` quando é string diferente. (Call do plano: a spec dizia `terms-required` para qualquer divergência; separar `stale` deixa o app dizer "atualize" no cadastro também.)
  - `register/options` chama o helper logo depois da checagem de nome (antes de qualquer throttle de e-mail); guarda `termsVersion` no challenge (`putChallenge({ ..., termsVersion })`); `register/verify` cria o usuário com `termsAcceptedVersion: c.termsVersion, termsAcceptedAt: user.created`. `register/password` idem, na mesma posição (depois do nome), gravando no objeto `user` antes de `createUser`.

- [ ] **Step 1: escrever os testes que falham**

`api/test/server-terms.test.js`, mesmo harness de `server-email-recovery.test.js` (copiar `SECRET`, `mintSession`, `softPasskey` com `attestation`, `startServer` com `users` em `db.json`, e `h.user(id)`/`h.pool()`), `APP_URL` em branco. Testes:

```js
test('GET /api/config carries legal_version for everyone', ...)
  // anon: body.legal_version === '2026-10-17'

test('register/options: no termsVersion → 400 terms-required; wrong type too; a stale one → terms-version-stale', ...)
  // body { name:'A', email:'a@x.io' } → 400 { code:'terms-required' }
  // termsVersion: 42 / '' / '   ' → 400 terms-required
  // termsVersion: '2020-01-01' → 400 terms-version-stale
  // nenhum desses cria usuário: SELECT count(*) FROM users === 0

test('a passkey signup with the current version lands with both columns set', ...)
  // options com termsVersion '2026-10-17' → 200; verify com softPasskey().attestation(challenge) → 200
  // h.user(id): terms_accepted_version === '2026-10-17', terms_accepted_at não nulo
  // GET /api/me com o cookie devolvido: needsTerms === false, termsVersion === '2026-10-17', termsAcceptedAt ISO

test('register/password (PASSWORD_LOGIN=1) follows the same rule', ...)
  // sem termsVersion → 400 terms-required; com → 200 e colunas gravadas; /api/me traz os três campos mesmo com PASSWORD_LOGIN

test('an account imported from db.json at boot needs the terms', ...)
  // users: [{ id:'u_old', name:'Old', created }] → GET /api/me (cookie mintSession('u_old')) → needsTerms true, termsVersion null, termsAcceptedAt null
```

Atualizar `server-config-session.test.js` (os quatro `deepEqual` passam a incluir `legal_version: '2026-10-17'`) e `server-token-refresh.test.js` L64 (`['user', 'email', 'emailVerified', 'needsEmail', 'termsVersion', 'termsAcceptedAt', 'needsTerms']`).

- [ ] **Step 2: rodar e ver falhar**

Run: `cd api && node --test test/server-terms.test.js test/server-config-session.test.js test/server-token-refresh.test.js`
Expected: FAIL (campos ausentes, 200 onde se espera 400).

- [ ] **Step 3: implementar em `server.js`** — importar `LEGAL_VERSION` de `./legal.js`; helper `termsVersionProblem`; as cinco rotas conforme Interfaces. No `register/options`, o `audit(... 'auth.register.denied', { msg: 'terms-required' | 'terms-stale' })` antes de responder, no estilo das recusas vizinhas.

- [ ] **Step 4: documentar em `openapi.yaml`** — `legal_version` em `/api/config`; `termsVersion`, `termsAcceptedAt`, `needsTerms` em `/api/me` (descrição: sempre presentes, inclusive com `PASSWORD_LOGIN`); `termsVersion` (`required`) nos request bodies de `register/options` e `register/password`, com os dois códigos 400 e exemplos.

- [ ] **Step 5: rodar e ver passar**

Run: `cd api && node --test test/server-terms.test.js test/server-config-session.test.js test/server-token-refresh.test.js test/openapi-routes.test.js`
Expected: PASS.

- [ ] **Step 6: commit**

```bash
git add api/server.js api/openapi.yaml api/test/server-terms.test.js api/test/server-config-session.test.js api/test/server-token-refresh.test.js
git commit -m "feat(api): signup requires the current LEGAL_VERSION; /api/config and /api/me expose it — ISO-1390"
```

---

### Task 7: `POST /api/account/terms/accept` e o gate do checkout

**Files:**
- Modify: `api/server.js` (tabela `THROTTLED` L935; rota nova perto de `POST /api/account/email/resend` L1877; `POST /api/billing/checkout` L2889)
- Modify: `api/openapi.yaml` (nova path `/api/account/terms/accept`, tag `auth`; 403 `terms-required` em `/api/billing/checkout`)
- Test: `api/test/server-terms.test.js` (acrescentar)

**Interfaces:**
- Consumes: `setTermsAccepted(pool, id, version, at)` (Task 5); `termsVersionProblem` (Task 6).
- Produces:
  - `POST /api/account/terms/accept` body `{ version }`: sem sessão → 401; `termsVersionProblem(body)` ≠ null → o 400 correspondente (`terms-required`/`terms-version-stale`); já aceito nesta versão → 200 `{ ok: true, termsVersion, termsAcceptedAt }` sem alterar nada; senão grava `now()` ISO, `audit(req, 'account.terms.accept', { user, msg: version })`, 200 com o mesmo corpo. Entrada `'POST /api/account/terms/accept': null` em `THROTTLED`.
  - `POST /api/billing/checkout`: logo após o `401`, **antes** da checagem de e-mail, `if (user.termsAcceptedVersion !== LEGAL_VERSION) return json(res, 403, { error: 'accept the current terms first', code: 'terms-required' })`. (Call do plano: o sheet de termos é o bloqueante; se faltam os dois, é ele que deve aparecer primeiro.)

- [ ] **Step 1: escrever os testes que falham** (em `server-terms.test.js`)

```js
test('account/terms/accept: session required, current version only, idempotent', ...)
  // sem cookie → 401
  // cookie u_old, body { version: '2020-01-01' } → 400 terms-version-stale; body {} → 400 terms-required
  // body { version: '2026-10-17' } → 200 { ok:true, termsVersion:'2026-10-17', termsAcceptedAt: <ISO> }
  // h.user('u_old').terms_accepted_at igual ao termsAcceptedAt devolvido
  // segunda chamada → 200 e terms_accepted_at idêntico ao da primeira (não regrava)
  // GET /api/me → needsTerms false
  // audit.log (ler path.join(h.dataDir, 'audit.log') como server-account-delete.test.js L88 faz): exatamente uma linha com ev 'account.terms.accept', uid 'u_old', msg '2026-10-17' — a segunda chamada não audita

test('billing/checkout refuses 403 terms-required before it looks at the e-mail', ...)
  // env: STRIPE_API_KEY:'sk_test_x', STRIPE_WEBHOOK_SECRET:'whsec_x' (BILLING_ON ligado; nenhum passo abaixo chega à Stripe)
  // u_a com email_verified_at = now() (UPDATE direto via h.pool()) e sem termos → POST { plan:'monthly' } → 403 { code:'terms-required' }
  // u_b sem e-mail verificado e sem termos → 403 terms-required (termos vêm antes do e-mail)
  // u_b aceita a versão vigente → o mesmo POST agora responde 403 { code:'email-unverified' } (o gate de termos passou; o de e-mail segura antes da Stripe)
```

- [ ] **Step 2: rodar e ver falhar**

Run: `cd api && node --test test/server-terms.test.js`
Expected: FAIL (404 na rota nova; checkout sem o 403).

- [ ] **Step 3: implementar** conforme Interfaces. Resposta de sucesso lê o usuário de novo (`getUserById`) para devolver o `termsAcceptedAt` gravado.

- [ ] **Step 4: documentar em `openapi.yaml`** — path nova com `operationId: acceptTerms`, request `{ version }`, respostas 200/400/401/429; no checkout, descrição e exemplo do 403 `terms-required` ao lado do `email-unverified`.

- [ ] **Step 5: rodar e ver passar**

Run: `cd api && node --test test/server-terms.test.js test/openapi-routes.test.js test/rate-limit.test.js`
Expected: PASS.

- [ ] **Step 6: commit**

```bash
git add api/server.js api/openapi.yaml api/test/server-terms.test.js
git commit -m "feat(api): POST /api/account/terms/accept; checkout refuses an account that never accepted — ISO-1390"
```

---

### Task 8: páginas `#/termos` e `#/privacidade`, texto em sheet empilhado

**Files:**
- Create: `frontend/src/components/LegalText.jsx`
- Create: `frontend/src/views/Legal.jsx`
- Modify: `frontend/src/App.jsx` (antes do branch `authed`, junto de `/verificar-email`)
- Modify: `frontend/src/locales/pt-BR.js`, `frontend/src/locales/pt.js`
- Test: `frontend/src/components/LegalText.test.jsx`, `frontend/src/views/Legal.test.jsx`

**Interfaces:**
- Consumes: módulos de `frontend/src/legal/` (contrato da Task 1).
- Produces:
  - `LegalText.jsx`: `export const LEGAL_DOCS = { termos, privacidade }`; `export function LegalText({ doc })` renderiza `<h2>` por seção, `<p>` por string, `<ul><li>` por `{list}`; `export function openLegalSheet(id)` → `useUI.getState().openSheet(close => <LegalSheet id={id} close={close} />)` (empilhado, não travado), onde `LegalSheet` mostra `<h3>{doc.title}</h3>`, `<div className="dim small">{t('Version {0}', doc.version)}</div>`, `<LegalText doc={doc} />` e um `<Button variant="ghost" onClick={close}>{t('Close')}</Button>`.
  - `views/Legal.jsx`: `export default function Legal({ id })` — cabeçalho com a marca (mesmo `brand-logo` de `EmailVerify.jsx`), `<h1>{doc.title}</h1>`, linha de versão, `<LegalText />`, botão `t('Back')` que faz `nav(-1)` quando `window.history.length > 1`, senão `nav('/home')`. Container `className="narrow"`, texto alinhado à esquerda, `lineHeight: 1.6`.
  - `App.jsx`: `if (loc.pathname === '/termos') return <><div id="app" className="vfade"><Legal id="termos" /></div><Modals /><Toast /></>`; idem `/privacidade`.
  - Strings novas (chaves em inglês): `'Version {0}'`, `'Close'` (verificar se já existe; se existir, não duplicar), `'Terms of Use'`, `'Privacy Policy'`.

- [ ] **Step 1: escrever os testes que falham**

`LegalText.test.jsx` (happy-dom, `createRoot` + `act` como `PasswordAuth.test.jsx`): com um doc de 2 seções, renderiza 2 `h2`, os `p` e os `li`; `openLegalSheet('termos')` empurra um sheet (mock de `useUI` como em `PasswordAuth.test.jsx`) cujo `render(close)` contém o título do doc e um botão que chama `close`.

`Legal.test.jsx`: envolve em `MemoryRouter`; `<Legal id="privacidade" />` mostra `h1` com `Política de Privacidade`, o texto `2026-10-17` e todos os headings do doc; `<Legal id="termos" />` mostra `Termos de Uso`.

- [ ] **Step 2: rodar e ver falhar**

Run: `cd frontend && npx vitest run src/components/LegalText.test.jsx src/views/Legal.test.jsx`
Expected: FAIL.

- [ ] **Step 3: implementar** os dois componentes, as rotas no `App.jsx` e as strings em `pt-BR.js` e `pt.js` (pt-BR: 'Versão {0}', 'Fechar', 'Termos de Uso', 'Política de Privacidade').

- [ ] **Step 4: rodar e ver passar**

Run: `cd frontend && npx vitest run src/components/LegalText.test.jsx src/views/Legal.test.jsx src/App.test.jsx`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add frontend/src/components/LegalText.jsx frontend/src/components/LegalText.test.jsx frontend/src/views/Legal.jsx frontend/src/views/Legal.test.jsx frontend/src/App.jsx frontend/src/locales/pt-BR.js frontend/src/locales/pt.js
git commit -m "feat(app): #/termos and #/privacidade, legal text in a stacked sheet — ISO-1390"
```

---

### Task 9: checkbox de aceite no cadastro

**Files:**
- Create: `frontend/src/components/TermsCheckbox.jsx`
- Modify: `frontend/src/components/SignupFlow.jsx` (`canSubmit` L39, chamada `passkeyRegister` L51, botão L93)
- Modify: `frontend/src/components/PasswordAuth.jsx` (`PasswordRegisterForm` L177–229)
- Modify: `frontend/src/lib/api.js` (`passkeyRegister` L279, `passwordRegister` L329)
- Modify: `frontend/src/locales/pt-BR.js`, `pt.js`
- Test: `frontend/src/components/SignupFlow.test.jsx` (novo), `frontend/src/components/PasswordAuth.test.jsx` (acrescentar), `frontend/src/lib/api.test.js` (acrescentar se já cobre `passkeyRegister`; senão novo `api.terms.test.js`)

**Interfaces:**
- Consumes: `openLegalSheet(id)` (Task 8); `LEGAL_VERSION`.
- Produces:
  - `TermsCheckbox({ checked, onChange })`: `<label className="small" style={{ display:'flex', gap:10, alignItems:'flex-start' }}>` com `<input type="checkbox" name="terms" checked onChange>` e o texto `t('I have read and accept the Terms of Use and the Privacy Policy.')`; abaixo, dois `<button type="button" className="linklike">` com `t('Read the Terms of Use')` → `openLegalSheet('termos')` e `t('Read the Privacy Policy')` → `openLegalSheet('privacidade')`. Desmarcado por padrão (estado do pai).
  - `SignupFlow`: estado `terms` (false); `canSubmit` exige `terms`; `passkeyRegister(n, code, email, birthDate, LEGAL_VERSION)`.
  - `PasswordRegisterForm`: idem; botão `disabled={busy || !terms}`; `passwordRegister(n, pw, code, mail, LEGAL_VERSION)`.
  - `api.js`: `passkeyRegister(name, code, email, birthDate, termsVersion)` manda `termsVersion` no body de `/api/register/options`; `passwordRegister(name, password, code, email, termsVersion)` manda `termsVersion` em `/api/register/password`.
  - Strings novas: `'I have read and accept the Terms of Use and the Privacy Policy.'`, `'Read the Terms of Use'`, `'Read the Privacy Policy'`.

- [ ] **Step 1: escrever os testes que falham**

`SignupFlow.test.jsx` (mocks no padrão de `PasswordAuth.test.jsx`; mockar `../lib/api.js` com `passkeyRegister: vi.fn(async () => ({ id:'u1', name:'A' }))`, `bio: () => 'x'`, e `./LegalText.jsx` com `openLegalSheet: vi.fn()`):
- com nome, e-mail e data válidos preenchidos e checkbox desmarcado, o botão `Create passkey` está `disabled`; marcado, habilita;
- ao clicar, `passkeyRegister` é chamado com o 5º argumento `'2026-10-17'`;
- clicar em `Read the Terms of Use` chama `openLegalSheet('termos')`.

`PasswordAuth.test.jsx`: novo `it` em `PasswordRegisterForm`: botão `Create profile` desabilitado até marcar; `passwordRegister` recebe `'2026-10-17'` como 5º argumento.

`api` test: `passkeyRegister('A','', 'a@x.io', '', '2026-10-17')` faz o primeiro `fetch` com body contendo `"termsVersion":"2026-10-17"`; `passwordRegister(..., '2026-10-17')` idem.

- [ ] **Step 2: rodar e ver falhar**

Run: `cd frontend && npx vitest run src/components/SignupFlow.test.jsx src/components/PasswordAuth.test.jsx src/lib/api.test.js`
Expected: FAIL.

- [ ] **Step 3: implementar** conforme Interfaces, mais as strings em pt-BR/pt (pt-BR: 'Li e aceito os Termos de Uso e a Política de Privacidade.', 'Ler os Termos de Uso', 'Ler a Política de Privacidade').

- [ ] **Step 4: rodar e ver passar**

Run: `cd frontend && npx vitest run src/components/SignupFlow.test.jsx src/components/PasswordAuth.test.jsx src/lib/api.test.js src/views/Login.password.test.jsx src/views/Settings.passkeys.test.jsx`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add frontend/src/components/TermsCheckbox.jsx frontend/src/components/SignupFlow.jsx frontend/src/components/SignupFlow.test.jsx frontend/src/components/PasswordAuth.jsx frontend/src/components/PasswordAuth.test.jsx frontend/src/lib/api.js frontend/src/lib/api.test.js frontend/src/locales/pt-BR.js frontend/src/locales/pt.js
git commit -m "feat(app): signup needs the terms checkbox and sends LEGAL_VERSION — ISO-1390"
```

---

### Task 10: sheet travado "Atualizamos nossos termos"

**Files:**
- Create: `frontend/src/lib/session-user.js`
- Create: `frontend/src/components/TermsSheet.jsx`
- Modify: `frontend/src/lib/api.js` (nova `termsAccept`)
- Modify: `frontend/src/store/useStore.js` (L1476 e L1563: usar `userFromMe`)
- Modify: `frontend/src/views/Login.jsx` (L75–76: usar `userFromMe`)
- Modify: `frontend/src/components/PasswordAuth.jsx` (`signedIn` L94: refazer `/api/me`)
- Modify: `frontend/src/App.jsx` (efeitos de `linkCode` e `needsEmail`; efeito novo)
- Modify: `frontend/src/App.test.jsx`
- Modify: `frontend/src/locales/pt-BR.js`, `pt.js`
- Test: `frontend/src/lib/session-user.test.js`, `frontend/src/components/TermsSheet.test.jsx`, `frontend/src/App.test.jsx`

**Interfaces:**
- Consumes: `openLegalSheet` (Task 8); `LEGAL_VERSION`; `useOnline()`/`isOnline()` de `components/ServerSync.jsx`; `useUI.openSheet(render, { locked: true })`; `MOBILE` de `lib/mobile.js`.
- Produces:
  - `lib/session-user.js`: `export function userFromMe(me, base = me.user)` → `{ ...base, ...('needsEmail' in me ? { email: me.email, emailVerified: !!me.emailVerified, needsEmail: !!me.needsEmail } : {}), termsVersion: me.termsVersion ?? null, termsAcceptedAt: me.termsAcceptedAt ?? null, needsTerms: !!me.needsTerms }`. Os três call sites existentes passam a usá-la; `signedIn` em `PasswordAuth.jsx` faz `const me = await api('/api/me').catch(() => null)` e `setUser(me ? userFromMe(me, u) : u, { adopt: true })`.
  - `api.js`: `export async function termsAccept(version)` → `post('/api/account/terms/accept', { version })`.
  - `TermsSheet.jsx`: `export function openTermsSheet()` → `openSheet(close => <TermsSheet close={close} />, { locked: true })`; `TermsSheet` mostra `<h3>{t('We updated our terms')}</h3>`, `t('To keep using Brilhart Fitness, read and accept the current Terms of Use and Privacy Policy.')`, dois botões-link (`Read the Terms of Use` / `Read the Privacy Policy` → `openLegalSheet`), e:
    - estado normal: `<Button variant="primary">{t('Accept and continue')}</Button>` → `termsAccept(LEGAL_VERSION)`; sucesso → `setUser({ ...user, termsVersion, termsAcceptedAt, needsTerms: false })` e `close()`; erro com `e.data?.code === 'terms-version-stale'` → estado stale; outro erro → `role="alert"` com `t('Could not save your acceptance — are you online?')`, sheet continua aberto;
    - estado stale (também quando `config.legal_version && config.legal_version !== LEGAL_VERSION` já na montagem): texto `t('Update the app to accept the new terms.')`; no web (`!MOBILE`) um `<Button>{t('Reload')}</Button>` que faz `window.location.reload()`; sem botão de aceitar.
    - Nenhum botão de fechar.
  - `App.jsx`: `const needsTerms = !!user?.needsTerms && !isGuest`; `const online = useOnline()`; efeito `useEffect(() => { if (!ready || !needsTerms || !online || termsOffered.current === user.id) return; termsOffered.current = user.id; openTermsSheet() }, [ready, needsTerms, online, user?.id])`; os efeitos de `linkCode` e `needsEmail` ganham `if (needsTerms) return` antes de consumir sua vez (sem marcar `offered`).
  - Strings novas: `'We updated our terms'`, `'To keep using Brilhart Fitness, read and accept the current Terms of Use and Privacy Policy.'`, `'Accept and continue'`, `'Update the app to accept the new terms.'`, `'Reload'`, `'Could not save your acceptance — are you online?'`.

- [ ] **Step 1: escrever os testes que falham**

`session-user.test.js`: com `me = { user:{id:'u'}, email:'a@x', emailVerified:true, needsEmail:false, termsVersion:'2026-10-17', termsAcceptedAt:'2026-10-17T00:00:00.000Z', needsTerms:false }` devolve todos os campos; com `me = { user:{id:'u'} }` (servidor antigo) devolve `needsTerms:false`, `termsVersion:null`, sem campos de e-mail; `base` sobrescreve `me.user`.

`TermsSheet.test.jsx` (mocks como `PasswordAuth.test.jsx`; `termsAccept` mockado):
- renderiza título, os dois links e o botão `Accept and continue`;
- clicar → `termsAccept('2026-10-17')`; sucesso → `setUser` com `needsTerms:false` e `close` chamado;
- `termsAccept` rejeita com `{ status:400, data:{ code:'terms-version-stale' } }` → aparece `Update the app to accept the new terms.` e `Reload`, `close` não chamado;
- rejeita com `{ status:0 }` → `role="alert"` com `Could not save your acceptance`, `close` não chamado;
- `config.legal_version = '2027-01-01'` na montagem → já começa no estado stale, sem botão de aceitar.

`App.test.jsx` (estender os mocks com `needsTerms`, `online`, e `vi.mock('./components/TermsSheet.jsx', () => ({ openTermsSheet: vi.fn() }))`; mockar `./components/ServerSync.jsx` `useOnline: () => mocks.online`):
- `needsTerms:true`, online → `openTermsSheet` chamado uma vez; `openNeedsEmailPrompt` e `openDeviceLinkRedeem` (com `linkCode`) **não** chamados;
- `needsTerms:true`, offline → `openTermsSheet` não chamado; ao virar online (rerender) → chamado;
- `isGuest:true` com `user` nulo → não chamado;
- `needsTerms:false` → não chamado e `openNeedsEmailPrompt` volta a disparar.

- [ ] **Step 2: rodar e ver falhar**

Run: `cd frontend && npx vitest run src/lib/session-user.test.js src/components/TermsSheet.test.jsx src/App.test.jsx`
Expected: FAIL.

- [ ] **Step 3: implementar** conforme Interfaces; strings em pt-BR/pt ('Atualizamos nossos termos', 'Para continuar usando o Brilhart Fitness, leia e aceite os Termos de Uso e a Política de Privacidade atuais.', 'Aceitar e continuar', 'Atualize o app para aceitar os novos termos.', 'Recarregar', 'Não foi possível registrar seu aceite — você está online?').

- [ ] **Step 4: rodar e ver passar**

Run: `cd frontend && npx vitest run src/lib/session-user.test.js src/components/TermsSheet.test.jsx src/App.test.jsx src/components/PasswordAuth.test.jsx src/views/Login.password.test.jsx src/store/`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add frontend/src/lib/session-user.js frontend/src/lib/session-user.test.js frontend/src/components/TermsSheet.jsx frontend/src/components/TermsSheet.test.jsx frontend/src/lib/api.js frontend/src/store/useStore.js frontend/src/views/Login.jsx frontend/src/components/PasswordAuth.jsx frontend/src/App.jsx frontend/src/App.test.jsx frontend/src/locales/pt-BR.js frontend/src/locales/pt.js
git commit -m "feat(app): locked 'we updated our terms' sheet, /api/me terms fields in the store — ISO-1390"
```

---

### Task 11: Configurações e checkout

**Files:**
- Modify: `frontend/src/views/Settings.jsx` (rodapé L604–608)
- Modify: `frontend/src/views/SettingsPlan.jsx` (L89)
- Modify: `frontend/src/locales/pt-BR.js`, `pt.js`
- Test: `frontend/src/views/Settings.legal.test.jsx` (novo), teste existente de `SettingsPlan` se houver (`grep -l SettingsPlan frontend/src/views/*.test.jsx`), senão `frontend/src/views/SettingsPlan.terms.test.jsx`

**Interfaces:**
- Consumes: `openTermsSheet` (Task 10); `dateLocale()` de `lib/i18n.js`; `user.termsVersion`/`termsAcceptedAt` do store.
- Produces:
  - Rodapé do Settings, nova linha antes de `Brilhart Fitness v…`: `<Link to="/termos">{t('Terms of Use')}</Link> · <Link to="/privacidade">{t('Privacy Policy')}</Link>`; e, quando `user?.termsAcceptedAt`, outra linha `t('You accepted version {0} on {1}.', user.termsVersion, new Date(user.termsAcceptedAt).toLocaleDateString(dateLocale()))`.
  - `SettingsPlan.jsx`: `if (e?.data?.code === 'terms-required') { openTermsSheet(); return }` antes da linha do `email-unverified`.
  - String nova: `'You accepted version {0} on {1}.'`.

- [ ] **Step 1: escrever os testes que falham**

`Settings.legal.test.jsx` (copiar o scaffolding de `Settings.account-id.test.jsx`): com `user = { id:'u', name:'A', termsVersion:'2026-10-17', termsAcceptedAt:'2026-10-17T12:00:00.000Z' }` o rodapé tem links com `href` terminando em `#/termos` e `#/privacidade` e o texto `You accepted version 2026-10-17`; sem `termsAcceptedAt`, os links aparecem e a frase não.

Teste do `SettingsPlan`: `billingCheckout` rejeita com `{ status:403, data:{ code:'terms-required' } }` → `openTermsSheet` chamado e nenhum erro de cartão exibido; com `email-unverified` continua chamando `openNeedsEmailPrompt`.

- [ ] **Step 2: rodar e ver falhar**

Run: `cd frontend && npx vitest run src/views/Settings.legal.test.jsx src/views/SettingsPlan`
Expected: FAIL.

- [ ] **Step 3: implementar** e strings em pt-BR/pt ('Você aceitou a versão {0} em {1}.').

- [ ] **Step 4: rodar e ver passar**

Run: `cd frontend && npx vitest run src/views/Settings src/views/SettingsPlan`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add frontend/src/views/Settings.jsx frontend/src/views/Settings.legal.test.jsx frontend/src/views/SettingsPlan.jsx frontend/src/views/SettingsPlan.terms.test.jsx frontend/src/locales/pt-BR.js frontend/src/locales/pt.js
git commit -m "feat(app): legal links and acceptance date in Settings; checkout's terms-required opens the sheet — ISO-1390"
```

---

### Task 12: os outros 14 locales, exportação final e suíte completa

**Files:**
- Modify: `frontend/src/locales/{ar,de,es,fr,hi,hu,it,ko,pl,ru,th,tr,uk,zh}.js`
- Regenerate: `docs/legal/*.md` (se Tasks 2–3 mudaram depois da 4)
- Modify: `CHANGELOG.md` (entrada ISO-1390)

- [ ] **Step 1: ver o que falta**

Run: `cd frontend && node scripts/check-locales.mjs`
Expected: lista as chaves novas ausentes em 14 locales (as adicionadas nas Tasks 8–11; nenhuma outra).

- [ ] **Step 2: traduzir** — em cada um dos 14 arquivos, antes do `}` final, um bloco com comentário `// ISO-1390 — terms & privacy acceptance` e todas as chaves listadas, preservando `{0}`/`{1}`. Nenhuma tradução em branco.

- [ ] **Step 3: verificar locales**

Run: `cd frontend && node scripts/check-locales.mjs`
Expected: `16 locales, N keys each — in sync`.

- [ ] **Step 4: regenerar o Markdown e a suíte inteira do frontend**

Run: `cd frontend && node scripts/legal-export.mjs && git status --short docs/legal && npx vitest run`
Expected: `docs/legal` sem diferenças (ou commitar as diferenças); vitest tudo verde.

- [ ] **Step 5: suíte da API com Postgres**

Run: `cd api && npm run test:pg 2>&1 | tail -40`
Expected: só as 11 falhas pré-existentes listadas em Global Constraints; `server-terms`, `store-terms`, `openapi-routes`, `server-config-session`, `server-token-refresh` passam.

- [ ] **Step 6: CHANGELOG e commit**

Entrada curta em `CHANGELOG.md` no formato das vizinhas (Termos/Política dentro do app, aceite obrigatório no cadastro com versão gravada, sheet para contas antigas, checkout exige aceite).

```bash
git add frontend/src/locales CHANGELOG.md docs/legal
git commit -m "i18n(app): terms & privacy strings in the other fourteen locales; changelog — ISO-1390"
git push -u origin feat/ISO-1390-termos-privacidade
```
