# colo doula

Aplicação web para conectar doulas e gestantes. Inclui cadastro e login, perfis persistidos em PostgreSQL, busca de doulas por cidade/bairro e serviço, mensagens privadas e links de pagamento externos.

## Requisitos

- Node.js 20 ou superior
- PostgreSQL 15 ou superior
- Um domínio e uma plataforma de hospedagem que aceite Node.js e PostgreSQL para publicar o serviço

## Executar localmente

1. Crie um banco PostgreSQL chamado `colo`.
2. Copie `.env.example` para `.env` e ajuste `DATABASE_URL` para seu PostgreSQL.
3. Execute `npm install`.
4. Execute `npm test` para verificar API, privacidade e conversas.
5. Execute `npm start` e abra `http://localhost:3000`.

Ao iniciar, o serviço cria as tabelas necessárias se elas ainda não existirem. Não são inseridos perfis ou avaliações fictícias.

## Publicar na Vercel

1. Importe o repositório `lolivnat/Colo-` na Vercel. O `index.js` exporta o app Express para execução como Function; os arquivos da pasta `public/` são publicados como assets estáticos.
2. Crie um PostgreSQL externo, por exemplo no Neon, de preferência na mesma região da Function. Use a URL de conexão com pooler fornecida pelo provedor.
3. Configure estas variáveis em **Settings → Environment Variables**:

- `NODE_ENV=production`
- `APP_ORIGIN`: origem HTTPS do deployment Vercel, sem caminho final
- `DATABASE_URL`: URL de conexão pooled do PostgreSQL
- `DATABASE_SSL=true` se exigido pelo provedor
- `TRUST_PROXY=true`
- `ADMIN_EMAILS`: e-mails da equipe, separados por vírgula
- `PAYMENT_CHECKOUT_URL`: checkout HTTPS do plano Padrão
- `PREMIUM_PAYMENT_CHECKOUT_URL`: checkout HTTPS do plano Premium

4. Faça o deploy. O schema é aplicado no primeiro acesso, com trava transacional para evitar inicializações concorrentes. Configure os valores de pagamento e confirme-os no provedor antes de ativar os planos.

As Functions da Vercel limitam o corpo de cada requisição a 4,5 MB; por isso, os comprovantes aceitam imagens de até 4 MB. O limitador de tentativas de login/cadastro usa memória do processo, que não é compartilhada entre Functions. Antes de abrir o serviço ao público, configure um rate limit compartilhado para produção.

## Publicar em Render e conectar colodoula.com

1. Envie este repositório ao seu GitHub e, no Render, crie um **Web Service** conectado a ele. Use `npm ci` como comando de build e `npm start` como comando de início.
2. Crie um PostgreSQL no Render, de preferência na mesma região do Web Service. Escolha um plano com persistência adequada ao uso real e configure backups.
3. No painel do Web Service, adicione estas variáveis de ambiente:

- `NODE_ENV=production`
- `APP_ORIGIN=https://colodoula.com`
- `DATABASE_URL`: URL **interna/privada** do PostgreSQL fornecida pelo Render
- `DATABASE_SSL=true` somente se exigido pela configuração do banco
- `TRUST_PROXY=true` (o Web Service fica atrás do proxy do Render)
- `ADMIN_EMAILS`: e-mails das contas autorizadas a analisar comprovantes, separados por vírgula
- `PAYMENT_CHECKOUT_URL`: link HTTPS para pagar o plano Padrão de R$ 39,90 (confirme no provedor que o valor e a cobrança mensal estão corretos antes de ativar)
- `PREMIUM_PAYMENT_CHECKOUT_URL`: link HTTPS separado para pagar o plano Premium de R$ 59,90; configure e confirme o valor antes de oferecer o plano
- `PORT`: fornecida automaticamente pelo Render

4. Em **Settings → Custom Domains**, adicione `colodoula.com`. No painel DNS da HostGator, crie os registros que o Render mostrar. Para um domínio raiz sem suporte a `ANAME`/`ALIAS`, a documentação atual do Render orienta usar um registro `A` para `@` apontando para `216.24.57.1`; para `www`, use `CNAME` para o subdomínio `onrender.com` do seu serviço. Remova registros `AAAA` que conflitem. Confirme os destinos sugeridos no dashboard do Render antes de salvar.
5. Aguarde a propagação, valide o domínio no Render e confirme que HTTPS foi ativado antes de divulgar o app.

Não publique segredos no repositório nem os envie por chat. O cookie de sessão só usa a flag `Secure` em produção. A criação do serviço, banco, DNS e eventuais cobranças deve ser confirmada por você na sua conta.

## Privacidade e limites da primeira versão

- Perfis de gestantes e informações de gestação nunca são incluídos nos resultados públicos. Apenas a própria pessoa pode consultar e editar seu perfil; ao iniciar uma conversa, a doula recebe somente as mensagens enviadas.
- Perfis de doulas ficam fora da busca até que a própria profissional marque a opção para publicá-los. A busca filtra por cidade/bairro, não usa GPS nem calcula distância exata.
- A área de contatos exige um plano mensal conferido manualmente pela equipe: Padrão por R$ 39,90 ou Premium por R$ 59,90. Ambos liberam 30 dias de acesso; apenas o Premium ativo prioriza o perfil na busca recomendada. O comprovante nunca libera acesso por conta própria. Doulas não pagantes também não conseguem ler ou enviar mensagens.
- O diretório contém apenas gestantes que, por vontade própria, marcaram a opção de aparecer e a opção separada de compartilhar o e-mail. Mostra somente nome, cidade, bairro e e-mail; dados e preferências da gestação nunca são incluídos. Revogar a autorização remove o contato do diretório.
- Para analisar comprovantes, cadastre uma conta da equipe e configure seu e-mail em `ADMIN_EMAILS`. A equipe deve conferir o recebimento no provedor de pagamentos antes de aprovar. As imagens aceitas (JPEG, PNG ou WebP, até 4 MB) são guardadas no PostgreSQL somente enquanto estão pendentes e apagadas após a decisão; registros de aprovação e validade do acesso permanecem.
- As contas usam senhas derivadas com scrypt e sessões em cookies `HttpOnly`, `SameSite=Lax`, com tokens aleatórios armazenados como hashes. A API valida a origem das alterações, limita tentativas de login/cadastro e só aceita links de pagamento HTTPS.
- O limite de tentativas usa armazenamento em memória por processo; se o serviço for escalado para várias instâncias, configure um armazenamento compartilhado de rate limit.
- Mensagens são privadas entre participantes, mas não têm criptografia ponta a ponta. O colo não processa pagamentos nem recebe dados de cartão; a gestante é direcionada ao link externo informado pela doula.
- Favoritos continuam salvos apenas no navegador e não são sincronizados entre dispositivos.

Antes de abrir ao público, confira a cobrança recorrente ou mensalidade no link do PagSeguro, configure verificação de e-mail e recuperação de senha, publique termos de uso e aviso de privacidade adequados à LGPD, escolha um provedor de hospedagem/banco com backups e monitoramento, e valide o fluxo de atendimento e moderação. Processamento automático de pagamentos, mapas, localização precisa e avaliações não fazem parte desta versão.
