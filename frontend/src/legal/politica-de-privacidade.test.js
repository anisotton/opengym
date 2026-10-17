// frontend/src/legal/politica-de-privacidade.test.js
import { describe, expect, it } from 'vitest'
import privacidade from './politica-de-privacidade.js'

const HEADINGS = ['Controladora e contato', 'Dados que tratamos e por quê', 'Dados de saúde', 'Menores de idade',
  'Com quem compartilhamos', 'Cookies e armazenamento local', 'Notificações push', 'Por quanto tempo guardamos',
  'Seus direitos e como exercer', 'Segurança', 'Coach com inteligência artificial', 'Alterações e versão']
const flat = doc => doc.sections.flatMap(s => s.paragraphs.map(p => typeof p === 'string' ? p : p.list.join('\n'))).join('\n')

describe('Política de Privacidade', () => {
  it('has the twelve sections of the design, in order', () => {
    expect(privacidade.id).toBe('privacidade')
    expect(privacidade.title).toBe('Política de Privacidade')
    expect(privacidade.sections.map(s => s.heading)).toEqual(HEADINGS)
  })
  it('states the decided facts', () => {
    const text = flat(privacidade)
    for (const fact of ['Brilhart Escola', 'Isotton', 'LGPD', 'Stripe', 'Coolify', 'privacidade@brilhart.com.br',
      '90 dias', '5 mil', 'ANPD', 'passkey', '12 anos', '18 anos', 'exportar', 'excluir', '[CONFIRMAR]',
      'provedor de inteligência artificial [CONFIRMAR]', 'medianas de pelo menos três pessoas', 'Res. ANPD 2/2022',
      'art. 9º, §3º', 'consentimento específico'])
      expect(text, fact).toContain(fact)
  })
  it('has no markup inside the strings', () => {
    expect(flat(privacidade)).not.toMatch(/<[a-z]|\*\*|^#/m)
  })
})
