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
    for (const fact of ['Brilhart Escola', 'GIOVANA NEGRINI ISOTTON - ME', '32.600.786/0001-74', 'Isotton',
      '7 dias', 'art. 49', '18 anos',
      'Não é possível concluir seu cadastro', 'AGPL', 'MIT', 'São Leopoldo',
      'atendimento@brilhart.com.br', '(51) 2165-8600'])
      expect(text, fact).toContain(fact)
  })
  it('does not commit to a fixed price, deferring to what the app shows at checkout', () => {
    const text = flat(termos)
    expect(text).toMatch(/valor exibido no app/)
    expect(text).toMatch(/mantém o valor que contratou/)
    expect(text).not.toMatch(/R\$\s?\d/)
  })
  it('has no leftover [CONFIRMAR] placeholder', () => {
    expect(flat(termos)).not.toContain('CONFIRMAR')
  })
  it('has no markup inside the strings', () => {
    expect(flat(termos)).not.toMatch(/<[a-z]|\*\*|^#/m)
  })
})
