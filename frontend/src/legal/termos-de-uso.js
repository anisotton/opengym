// Termos de Uso of Brilhart Fitness. Plain strings only (no markup): the views render headings,
// paragraphs and { list } items themselves.
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
        'Quem vende o serviço e responde por ele perante você é a Brilhart Escola — razão social GIOVANA NEGRINI ISOTTON - ME, CNPJ 32.600.786/0001-74, com endereço na R. João Neves da Fontoura, 532, Sala 305, Centro, São Leopoldo/RS, CEP 93010-050. Nestes termos, "nós" se refere à Brilhart Escola.',
        'O desenvolvimento e a operação técnica do aplicativo (servidores, atualizações e segurança) são feitos pela Isotton, que atua em nome da Brilhart Escola.',
        'Ao criar sua conta e marcar que leu e aceita estes Termos de Uso e a Política de Privacidade (ou, se já tem conta, ao aceitá-los no próximo acesso), você fecha um contrato conosco nas condições abaixo. Se não concordar com algum ponto, não crie a conta.',
      ],
    },
    {
      heading: 'Conta, passkeys e e-mail',
      paragraphs: [
        'Para usar o app você cria uma conta com seu nome e seu e-mail. O e-mail precisa ser confirmado pelo link que enviamos para ele antes de a conta ficar ativa.',
        'O acesso é feito por passkey: uma chave de acesso guardada no seu celular, computador ou gerenciador de senhas, desbloqueada com sua digital, rosto ou PIN do aparelho. Se o login por senha estiver disponível para você, a senha é pessoal e você não deve reutilizá-la em outros serviços.',
        'Você é responsável por:',
        {
          list: [
            'informar dados verdadeiros e manter seu e-mail atualizado;',
            'manter o acesso ao seu e-mail, porque é por ele que avisamos sobre cobranças, mudanças nestes termos e recuperação de acesso;',
            'proteger os dispositivos onde suas passkeys estão guardadas e removê-las da conta (em Configurações) se perder um aparelho;',
            'tudo o que for feito na sua conta a partir dos seus dispositivos ou credenciais, salvo quando houver falha de segurança nossa.',
          ],
        },
        'Se suspeitar de acesso indevido, fale com a gente pelos canais da última seção o quanto antes.',
      ],
    },
    {
      heading: 'Idade mínima e responsáveis',
      paragraphs: [
        'A Brilhart Fitness é destinada a maiores de 18 anos. Não aceitamos o cadastro de menores de 18 anos — nem com autorização do pai, da mãe ou de outro responsável legal.',
        'Se a data de nascimento informada no cadastro indicar menos de 18 anos, o cadastro não é concluído, e você verá o aviso: "A Brilhart Fitness é destinada a maiores de 18 anos. Não é possível concluir seu cadastro."',
        'Se, ainda assim, identificarmos uma conta de pessoa menor de 18 anos, encerramos a conta e excluímos os dados associados; fale com a gente pelo canal de privacidade se isso acontecer.',
      ],
    },
    {
      heading: 'Assinatura, preços, primeiro mês e renovação',
      paragraphs: [
        'O Brilhart Fitness é um serviço pago por assinatura, com os planos Mensal, Trimestral e Anual. O preço de cada plano, e de qualquer condição especial de primeiro mês, é o valor exibido no app — na tela de planos e depois no checkout — no momento em que você contrata ou troca de plano; não repetimos esse valor aqui porque ele pode mudar.',
        'Se o plano escolhido tiver um valor reduzido só no primeiro mês, cobramos esse valor primeiro. Antes da cobrança seguinte, já no valor cheio do plano, enviamos um e-mail avisando a data e o valor, para você decidir com calma se quer continuar.',
        'O pagamento é processado pela Stripe, nossa parceira de pagamentos. Os dados do seu cartão são informados diretamente à Stripe; nós não vemos nem guardamos o número completo do cartão.',
        'A assinatura renova automaticamente ao fim de cada período (mês, trimestre ou ano), cobrando o mesmo meio de pagamento, até que você cancele. Se uma cobrança falhar, a assinatura pode ficar suspensa até que o pagamento seja concluído.',
        'Podemos mudar os preços dos planos. Quem já é assinante mantém o valor que contratou — a mudança não se aplica à assinatura em andamento. O novo valor só vale para contratações novas e para quem decidir trocar de plano, e nesse caso é o valor do novo plano exibido no app no momento da troca.',
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
            'não usar robôs ou raspagem de dados contra o serviço hospedado;',
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
            'os textos de descrição e instrução dos exercícios da biblioteca geral vêm do conjunto de dados hasaneyldrm/exercises-dataset, sob a licença MIT;',
            'as animações e imagens dos exercícios da Brilhart são de titularidade da Brilhart Fitness, com todos os direitos reservados, exibidas no app apenas para ilustrar os exercícios — você não pode copiá-las nem redistribuí-las;',
            'as instruções dos exercícios da Brilhart passam por revisão de profissional da Brilhart Fitness; enquanto não revisadas, aparecem no app marcadas como rascunho, sem prejuízo do aviso de saúde mais adiante nestes termos;',
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
            'lesões decorrentes de uso inadequado do app ou de execução incorreta dos exercícios;',
            'perda de acesso causada pela perda dos seus dispositivos, passkeys ou do acesso ao seu e-mail;',
            'falhas da sua conexão com a internet, do seu aparelho ou de serviços de terceiros que você escolheu usar, como seu provedor de internet ou gerenciador de senhas;',
            'uso da sua conta por pessoas a quem você deu acesso.',
          ],
        },
        'Recomendamos que você exporte seus dados de tempos em tempos e guarde uma cópia própria.',
      ],
    },
    {
      heading: 'Alterações destes termos e versão',
      paragraphs: [
        `Cada versão destes termos é identificada pela data em que entrou em vigor. A versão atual é a de ${LEGAL_VERSION}.`,
        'Podemos atualizar estes termos para acompanhar mudanças no app ou na lei. Mudanças de preço seguem a regra da seção "Assinatura, preços, primeiro mês e renovação". Quando a mudança for relevante, você verá o novo texto e precisará aceitá-lo no próximo acesso para continuar usando o app. Se você não aceitar, a versão anterior continua valendo até o fim do período já pago, e a assinatura não renova. Você também pode exportar e excluir seus dados a qualquer momento.',
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
