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
    for (const fact of ['Brilhart Escola', 'GIOVANA NEGRINI ISOTTON - ME', '32.600.786/0001-74', 'Isotton',
      'LGPD', 'Stripe', 'HostGator', 'Coolify', 'Contabo', 'Alemanha', 'art. 33', 'contato@brilhart.com.br',
      '90 dias', '5 mil', '30 dias', 'ANPD', 'passkey', '18 anos', 'Não é possível concluir seu cadastro',
      'obrigatória no cadastro', 'exportar', 'excluir',
      'o provedor será informado nesta Política antes de o recurso ser ativado',
      'medianas de pelo menos três pessoas', 'Res. CD/ANPD nº 2/2022',
      'art. 9º, §3º', 'consentimento específico'])
      expect(text, fact).toContain(fact)
  })
  it('has no leftover [CONFIRMAR] placeholder', () => {
    expect(flat(privacidade)).not.toContain('CONFIRMAR')
  })
  it('has no markup inside the strings', () => {
    expect(flat(privacidade)).not.toMatch(/<[a-z]|\*\*|^#/m)
  })
})
