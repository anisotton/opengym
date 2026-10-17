// Termos de Uso of Brilhart Fitness. Plain strings only (no markup): the views render headings,
// paragraphs and { list } items themselves. [CONFIRMAR] marks facts the business still has to supply.
import { LEGAL_VERSION } from './version.js'

export default {
  id: 'termos',
  version: LEGAL_VERSION,
  title: 'Termos de Uso',
  sections: [
    {
      heading: 'Quem somos e o que é o serviço',
      paragraphs: [
        'O Brilhart Fitness é um aplicativo para você registrar seus treinos, acompanhar as cargas que levanta, montar e seguir rotinas e anotar seu peso corporal ao longo do tempo. Ele funciona no navegador, pode ser instalado na tela inicial do celular e também tem uma versão para Android.',
        'Quem vende o serviço e responde por ele perante você é a Brilhart Escola — [CONFIRMAR razão social], CNPJ [CONFIRMAR], com endereço na R. João Neves da Fontoura, 532, Sala 305, Centro, São Leopoldo/RS, CEP 93010-050. Nestes termos, "nós" se refere à Brilhart Escola.',
        'O desenvolvimento e a operação técnica do aplicativo (servidores, atualizações e segurança) são feitos pela Isotton, que atua em nome da Brilhart Escola.',
        'Ao criar sua conta e marcar que leu e aceita estes Termos de Uso e a Política de Privacidade, você fecha um contrato conosco nas condições abaixo. Se não concordar com algum ponto, não crie a conta.',
      ],
    },
    {
      heading: 'Conta, passkeys e e-mail',
      paragraphs: [
        'Para usar o app você cria uma conta com seu nome e seu e-mail. O e-mail precisa ser confirmado pelo link que enviamos para ele antes de a conta ficar ativa.',
        'O acesso é feito por passkey: uma chave de acesso guardada no seu celular, computador ou gerenciador de senhas, desbloqueada com sua digital, rosto ou PIN do aparelho. Login por senha só existe se estiver habilitado na instância que você usa; quando estiver, a senha é pessoal e você não deve reutilizá-la em outros serviços.',
        'Você é responsável por:',
        {
          list: [
            'informar dados verdadeiros e manter seu e-mail atualizado;',
            'manter o acesso ao seu e-mail, porque é por ele que avisamos sobre cobranças, mudanças nestes termos e recuperação de acesso;',
            'proteger os dispositivos onde suas passkeys estão guardadas e removê-las da conta (em Configurações) se perder um aparelho;',
            'tudo o que for feito na sua conta a partir dos seus dispositivos ou credenciais.',
          ],
        },
        'Se suspeitar de acesso indevido, fale com a gente pelos canais da última seção o quanto antes.',
      ],
    },
    {
      heading: 'Idade mínima e responsáveis',
      paragraphs: [
        'O Brilhart Fitness é destinado a pessoas com 18 anos ou mais.',
        'Menores de 18 anos só podem usar o app com autorização do pai, da mãe ou do responsável legal. Nesse caso, quem contrata a assinatura, aceita estes termos e responde pelo uso é o responsável.',
        'Para crianças menores de 12 anos, o uso e o tratamento dos dados exigem o consentimento específico e destacado do responsável, como determina a Lei Geral de Proteção de Dados (LGPD). Se descobrirmos uma conta de menor sem essa autorização, podemos suspendê-la até que o responsável entre em contato.',
      ],
    },
    {
      heading: 'Assinatura, preços, primeiro mês e renovação',
      paragraphs: [
        'O Brilhart Fitness é um serviço pago por assinatura. Os planos e preços atuais são:',
        {
          list: [
            'Mensal: R$ 89 por mês;',
            'Trimestral: R$ 237 a cada 3 meses;',
            'Anual: R$ 768 por ano.',
          ],
        },
        'Em qualquer plano, o primeiro mês custa R$ 1,99. Antes da primeira cobrança no valor cheio do plano escolhido, enviamos um e-mail avisando a data e o valor, para você decidir com calma se quer continuar.',
        'O pagamento é processado pela Stripe, nossa parceira de pagamentos. Os dados do seu cartão são informados diretamente à Stripe; nós não vemos nem guardamos o número completo do cartão.',
        'A assinatura renova automaticamente ao fim de cada período (mês, trimestre ou ano), cobrando o mesmo meio de pagamento, até que você cancele. Se uma cobrança falhar, a assinatura pode ficar suspensa até que o pagamento seja concluído.',
        'Podemos alterar os preços. Se isso acontecer, avisamos por e-mail com pelo menos 30 dias de antecedência, e o novo valor só vale a partir da renovação seguinte ao aviso. Se não concordar, basta cancelar antes dela.',
      ],
    },
    {
      heading: 'Cancelamento, arrependimento e reembolso',
      paragraphs: [
        'Direito de arrependimento: como a contratação é feita pela internet, você pode desistir em até 7 dias a partir da contratação, sem precisar explicar o motivo, conforme o Código de Defesa do Consumidor (CDC, art. 49). Nesse caso devolvemos integralmente o valor pago, pelo mesmo meio de pagamento.',
        'Depois desse prazo:',
        {
          list: [
            'no plano mensal, você pode cancelar a qualquer momento; a cobrança seguinte não acontece e o acesso continua até o fim do mês já pago;',
            'nos planos trimestral e anual, o cancelamento impede a próxima renovação, e o acesso continua até o fim do período já pago, sem reembolso proporcional do tempo restante.',
          ],
        },
        'Para cancelar, abra Configurações → Plano no app e entre no portal de assinatura da Stripe, onde você também troca o cartão e vê suas faturas. Se preferir, peça o cancelamento ou o reembolso pelos canais de contato da última seção.',
        'Cancelar a assinatura não apaga sua conta nem seus dados. Para isso, use a exclusão de conta descrita na seção "Disponibilidade, mudanças e encerramento".',
      ],
    },
    {
      heading: 'Uso aceitável e suas obrigações',
      paragraphs: [
        'A assinatura é pessoal e dá direito ao uso por uma única pessoa. Ao usar o app, você se compromete a:',
        {
          list: [
            'usar o serviço para acompanhar os seus próprios treinos, sem revendê-lo ou explorá-lo comercialmente;',
            'não compartilhar sua conta nem suas credenciais com outras pessoas;',
            'não tentar burlar a segurança, acessar contas ou dados de terceiros, sobrecarregar os servidores ou contornar a cobrança;',
            'não usar robôs, raspagem de dados ou engenharia reversa no serviço hospedado, exceto o que a licença do código-fonte permite;',
            'enviar apenas fotos, vídeos e textos que sejam seus ou que você tenha direito de usar, sem conteúdo ilegal, ofensivo ou que exponha outras pessoas sem autorização.',
          ],
        },
        'Se você descumprir estas regras, podemos remover o conteúdo em questão, suspender ou encerrar a conta, como descrito adiante.',
      ],
    },
    {
      heading: 'Conteúdo, licenças e propriedade intelectual',
      paragraphs: [
        'O Brilhart Fitness reúne peças com licenças diferentes:',
        {
          list: [
            'o código-fonte do aplicativo é software livre, licenciado sob a GNU AGPL-3.0 (Affero General Public License, versão 3 ou posterior), e está disponível em https://github.com/anisotton/opengym;',
            'os textos de descrição e instrução dos exercícios vêm do conjunto de dados hasaneyldrm/exercises-dataset, sob a licença MIT;',
            'as imagens e GIFs dos exercícios são de terceiros (Gym visual), com todos os direitos reservados aos seus titulares, e são exibidos no app apenas para ilustrar os exercícios — você não pode copiá-los ou redistribuí-los;',
            'a marca, o nome e a identidade visual da Brilhart Escola e do Brilhart Fitness pertencem aos seus titulares e não podem ser usados sem autorização.',
          ],
        },
        'Os seus registros de treino, rotinas, medidas, fotos e vídeos continuam sendo seus. Você nos concede apenas uma licença limitada, gratuita e revogável para armazenar, processar e exibir esse conteúdo dentro do app, para você, na medida necessária para prestar o serviço. Não usamos suas fotos ou vídeos para publicidade nem os mostramos a outros usuários.',
        'Essa licença termina quando você exclui o conteúdo ou a conta, ressalvadas as cópias de segurança, que são apagadas no ciclo normal descrito na Política de Privacidade.',
      ],
    },
    {
      heading: 'Aviso de saúde',
      paragraphs: [
        'O Brilhart Fitness é uma ferramenta de registro e organização de treinos. As rotinas, sugestões de carga, progressões, estimativas de força e indicadores de recuperação que ele mostra são cálculos automáticos e não substituem a orientação de um profissional de educação física, de um médico ou de outro profissional de saúde.',
        'Procure um médico antes de iniciar ou intensificar qualquer atividade física, principalmente se você tem alguma condição de saúde, lesão, está grávida ou faz uso de medicação.',
        'Respeite seus limites, use técnica adequada e interrompa o exercício se sentir dor, tontura, falta de ar ou qualquer mal-estar.',
      ],
    },
    {
      heading: 'Disponibilidade, mudanças e encerramento',
      paragraphs: [
        'Trabalhamos para manter o app no ar e seus dados seguros, mas não garantimos que o serviço funcione de forma contínua e sem falhas. Podem ocorrer interrupções por manutenção, atualizações, problemas de rede ou de fornecedores; sempre que possível, avisamos antes as manutenções programadas.',
        'O app evolui: podemos adicionar, mudar ou remover funcionalidades.',
        'Podemos suspender ou encerrar sua conta se você violar estes termos, usar o serviço de forma fraudulenta ou se a lei exigir. Em casos que não envolvam risco ou fraude, avisamos antes e damos a chance de corrigir.',
        'Você pode, a qualquer momento e pelo próprio app, em Configurações, exportar seus dados (em JSON ou ZIP) e excluir sua conta. Se decidirmos encerrar o serviço como um todo, avisaremos com antecedência razoável para que você possa exportar tudo, e devolveremos o valor proporcional ao período pago e não usado.',
      ],
    },
    {
      heading: 'Responsabilidade',
      paragraphs: [
        'Respondemos pelo serviço nos termos do Código de Defesa do Consumidor. Nada nestes termos afasta ou reduz os direitos que o CDC garante a você.',
        'Dentro do que a lei permite, não respondemos por:',
        {
          list: [
            'lesões ou problemas de saúde decorrentes de uso inadequado do app, de execução incorreta dos exercícios ou de treino sem a orientação profissional recomendada no aviso de saúde;',
            'perda de acesso causada pela perda dos seus dispositivos, passkeys ou do acesso ao seu e-mail;',
            'falhas da sua conexão com a internet, do seu aparelho ou de serviços de terceiros que não estejam sob nosso controle;',
            'uso da sua conta por pessoas a quem você deu acesso.',
          ],
        },
        'Recomendamos que você exporte seus dados de tempos em tempos e guarde uma cópia própria.',
      ],
    },
    {
      heading: 'Alterações destes termos e versão',
      paragraphs: [
        `Cada versão destes termos é identificada pela data em que entrou em vigor. A versão atual é a Versão ${LEGAL_VERSION}.`,
        'Podemos atualizar estes termos para acompanhar mudanças no app, nos preços ou na lei. Quando a mudança for relevante, você verá o novo texto e precisará aceitá-lo no próximo acesso para continuar usando o app; se não concordar, pode cancelar a assinatura e exportar e excluir seus dados.',
        'A versão que você aceitou e a data do aceite ficam registradas na sua conta.',
      ],
    },
    {
      heading: 'Lei, foro e contato',
      paragraphs: [
        'Estes termos seguem a lei brasileira, em especial o Código de Defesa do Consumidor, o Marco Civil da Internet e a Lei Geral de Proteção de Dados.',
        'Fica eleito o foro da comarca de São Leopoldo/RS para resolver qualquer questão sobre estes termos, sem prejuízo do seu direito, como consumidor, de propor a ação no foro do seu domicílio.',
        'Antes de qualquer coisa, fale com a gente — a maioria dos problemas se resolve rápido:',
        {
          list: [
            'e-mail: atendimento@brilhart.com.br;',
            'WhatsApp: (51) 2165-8600;',
            'endereço: R. João Neves da Fontoura, 532, Sala 305, Centro, São Leopoldo/RS, CEP 93010-050.',
          ],
        },
      ],
    },
  ],
}
