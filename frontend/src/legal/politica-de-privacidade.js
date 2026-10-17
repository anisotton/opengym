// Política de Privacidade of Brilhart Fitness. Plain strings only (no markup): the views render headings,
// paragraphs and { list } items themselves. [CONFIRMAR] marks facts the business still has to supply.
import { LEGAL_VERSION } from './version.js'

export default {
  id: 'privacidade',
  version: LEGAL_VERSION,
  title: 'Política de Privacidade',
  sections: [
    {
      heading: 'Controladora e contato',
      paragraphs: [
        'Esta política explica quais dados pessoais o Brilhart Fitness trata, para quê, com quem eles são compartilhados e como você controla tudo isso, de acordo com a Lei Geral de Proteção de Dados (LGPD, Lei 13.709/2018).',
        'A controladora dos seus dados, ou seja, quem decide como eles são tratados e responde por isso, é a Brilhart Escola — [CONFIRMAR razão social], CNPJ [CONFIRMAR], com endereço na R. João Neves da Fontoura, 532, Sala 305, Centro, São Leopoldo/RS, CEP 93010-050. Nesta política, "nós" se refere à Brilhart Escola.',
        'A Isotton faz o desenvolvimento e a operação técnica do aplicativo e trata os dados como operadora, só em nome da Brilhart Escola e seguindo as instruções dela.',
        'Para qualquer assunto de privacidade, inclusive falar com o encarregado pelo tratamento de dados, escreva para privacidade@brilhart.com.br [CONFIRMAR].',
      ],
    },
    {
      heading: 'Dados que tratamos e por quê',
      paragraphs: [
        'Tratamos apenas o necessário para o app funcionar. Cada item abaixo diz o dado, para que ele serve e a base legal da LGPD que permite tratá-lo:',
        {
          list: [
            'Nome — identificar sua conta e falar com você — execução de contrato;',
            'E-mail — confirmar a conta pelo link que enviamos, recuperar seu acesso e enviar avisos de cobrança e de mudanças nos termos — execução de contrato;',
            'Data de nascimento (opcional) — só para mostrar um aviso quando a pessoa tem menos de 18 anos — execução de contrato;',
            'Passkeys — permitir seu login; guardamos apenas a chave pública, e a chave privada nunca sai do seu dispositivo — execução de contrato;',
            'Senha (só quando o login por senha estiver disponível) — permitir seu login; guardamos apenas um hash da senha, nunca a senha em si — execução de contrato;',
            'Treinos, cargas, rotinas e peso corporal — é o próprio serviço: registrar, mostrar sua evolução e calcular progressões — consentimento, por poderem ser dados de saúde (veja a próxima seção);',
            'Fotos e vídeos anexados a treinos (opcional, só quando você mesmo envia) — guardar e mostrar esse conteúdo para você dentro do app — consentimento;',
            'Identificadores e status da assinatura — saber se sua assinatura está ativa; os dados do cartão ficam com a Stripe, e nós não os vemos — execução de contrato e, para registros fiscais, obrigação legal;',
            'Inscrição para notificações push (opcional) — enviar os avisos que você ativou — consentimento;',
            'Log de segurança — registrar entradas na conta e ações administrativas para detectar e investigar abusos; por padrão não guarda o seu endereço IP — legítimo interesse;',
            'Cookie de sessão assinado — manter você conectado com segurança — execução de contrato.',
          ],
        },
        'Não usamos ferramentas de análise de comportamento, rastreadores de terceiros nem cookies de marketing, e não vendemos seus dados.',
      ],
    },
    {
      heading: 'Dados de saúde',
      paragraphs: [
        'Seus treinos, cargas e peso corporal podem revelar informações sobre sua saúde. Por isso, tratamos esses dados como dados pessoais sensíveis (LGPD, art. 11): só com o seu consentimento, dado no cadastro, e apenas para prestar o serviço a você.',
        'A equipe não vê seu histórico de treinos no painel de administração do app. Esses dados não são usados para publicidade nem compartilhados com outros usuários.',
        'Você pode retirar esse consentimento a qualquer momento excluindo sua conta, como explicado na seção "Seus direitos e como exercer".',
      ],
    },
    {
      heading: 'Menores de idade',
      paragraphs: [
        'O Brilhart Fitness é destinado a pessoas com 18 anos ou mais.',
        'Menores de 18 anos só podem usar o app com autorização do pai, da mãe ou do responsável legal. Para crianças menores de 12 anos, o tratamento dos dados exige o consentimento específico e destacado do responsável, como determina a LGPD.',
        'Se descobrirmos dados de uma criança tratados sem esse consentimento, podemos suspender a conta até que o responsável entre em contato pelo canal de privacidade.',
      ],
    },
    {
      heading: 'Com quem compartilhamos',
      paragraphs: [
        'Não vendemos nem alugamos seus dados. Eles são compartilhados apenas com os operadores de que precisamos para prestar o serviço, cada um recebendo só o necessário para a sua parte:',
        {
          list: [
            'Stripe — processa os pagamentos e guarda os dados do cartão e as faturas;',
            'provedor de e-mail transacional [CONFIRMAR] — envia os e-mails de confirmação de conta, recuperação de acesso e avisos de cobrança;',
            'hospedagem — os servidores do app, administrados com a plataforma Coolify, ficam em [CONFIRMAR local/provedor];',
            'a Isotton, como operadora técnica, conforme a seção "Controladora e contato".',
          ],
        },
        'Quando um desses operadores tratar dados fora do Brasil, essa transferência internacional só acontece com as garantias exigidas pela LGPD.',
        'Também podemos fornecer dados quando uma lei ou uma ordem judicial obrigar.',
      ],
    },
    {
      heading: 'Cookies e armazenamento local',
      paragraphs: [
        'O app usa um único cookie: o cookie de sessão assinado, que mantém você conectado. Ele não serve para rastrear você nem é compartilhado com terceiros.',
        'Para funcionar rápido e até sem internet, o app guarda o estado dos seus treinos no armazenamento local (localStorage) do seu próprio dispositivo, e no app Android também em um arquivo do próprio aparelho. Esses dados ficam no seu aparelho e são sincronizados com a sua conta quando você está conectado.',
        'Não há cookies de publicidade, de análise ou de rastreamento.',
      ],
    },
    {
      heading: 'Notificações push',
      paragraphs: [
        'As notificações push (como o fim do tempo de descanso e os lembretes de treino) são opcionais e só são ativadas se você permitir.',
        'Quando você ativa, guardamos uma inscrição para cada dispositivo onde permitiu. Ela é usada só para enviar esses avisos, que passam pelo serviço de notificações do seu navegador ou sistema.',
        'Você pode desligar a qualquer momento nas configurações do navegador, do celular ou do app; inscrições que deixam de funcionar são apagadas automaticamente.',
      ],
    },
    {
      heading: 'Por quanto tempo guardamos',
      paragraphs: [
        'Guardamos os dados apenas pelo tempo necessário:',
        {
          list: [
            'dados da conta, treinos, fotos e vídeos: enquanto sua conta existir;',
            'log de segurança: os registros mais recentes, até 90 dias ou 5 mil eventos, o que vier primeiro; por padrão sem endereço IP;',
            'registros fiscais e de pagamento: ficam com a Stripe pelo prazo exigido em lei;',
            'cópias de segurança: são sobrescritas em até [CONFIRMAR] dias, então um dado apagado da conta some também das cópias dentro desse prazo.',
          ],
        },
        'Cancelar a assinatura não apaga sua conta. Seus dados só são apagados quando você exclui a conta.',
      ],
    },
    {
      heading: 'Seus direitos e como exercer',
      paragraphs: [
        'A LGPD garante a você, entre outros, o direito de confirmar que tratamos seus dados, acessá-los, corrigi-los, levá-los para outro serviço, pedir sua eliminação, saber com quem os compartilhamos e retirar o consentimento.',
        'Boa parte disso você faz sozinho, pelo próprio app, em Configurações:',
        {
          list: [
            'exportar todos os seus dados, em JSON ou ZIP;',
            'excluir sua conta, o que apaga o estado do app, suas mídias, suas passkeys, suas sessões e seu cadastro de cliente na Stripe;',
            'trocar seu e-mail e remover passkeys de aparelhos que você não usa mais.',
          ],
        },
        'Para os demais direitos, como corrigir seu nome, ou se tiver qualquer dúvida, escreva para o canal de privacidade indicado na primeira seção.',
        'Se achar que seus direitos não foram respeitados, você também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).',
      ],
    },
    {
      heading: 'Segurança',
      paragraphs: [
        'Protegemos seus dados com medidas técnicas adequadas, entre elas:',
        {
          list: [
            'login por passkey, que não depende de senha e resiste a sites falsos;',
            'conexão sempre criptografada (HTTPS);',
            'cookie de sessão assinado, que não pode ser forjado;',
            'senha, quando existe, guardada apenas como hash;',
            'sessões que podem ser encerradas por dispositivo, de modo que sair em um aparelho invalida aquele acesso.',
          ],
        },
        'Nenhum sistema é totalmente imune a falhas. Se ocorrer um incidente de segurança que possa trazer risco ou dano relevante a você, avisaremos você e a ANPD, como exige a LGPD.',
      ],
    },
    {
      heading: 'Coach com inteligência artificial',
      paragraphs: [
        'Quando o recurso estiver ativado nesta instância, o app pode oferecer um Coach que usa inteligência artificial para revisar seus treinos e sugerir ajustes.',
        'Para isso, um resumo dos seus treinos é enviado a um provedor de inteligência artificial [CONFIRMAR provedor]. Isso só acontece depois que você dá um consentimento próprio para o Coach, dentro do app, e você pode desligá-lo a qualquer momento.',
      ],
    },
    {
      heading: 'Alterações e versão',
      paragraphs: [
        `Cada versão desta política é identificada pela data em que entrou em vigor. A versão atual é a Versão ${LEGAL_VERSION}.`,
        'Podemos atualizar esta política para acompanhar mudanças no app ou na lei. Quando a mudança for relevante, você verá o novo texto e precisará aceitá-lo no próximo acesso para continuar usando o app.',
        'A versão que você aceitou e a data do aceite ficam registradas na sua conta.',
      ],
    },
  ],
}
