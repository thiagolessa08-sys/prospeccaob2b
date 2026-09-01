-- A descoberta passa a poder vir da Lusha, e não só da Receita.
--
-- Empresa vinda da Lusha não tem CNPJ: ela vem do grafo dela, identificada
-- por um id próprio e por domínio. Isso quebra duas premissas do schema
-- original, que nasceu assumindo que toda empresa vinha da Casa dos Dados.

-- O identificador no fornecedor de origem. Para a Lusha é o company id, que é
-- o que permite pedir os contatos DAQUELA empresa em vez de procurá-la de
-- novo por nome — que é justamente onde o casamento entre Receita e Lusha
-- falhava.
alter table companies add column external_id text;

-- Dedup por fornecedor. O índice de CNPJ continua valendo para quem vem da
-- Receita; este cobre quem não tem CNPJ. Parcial, como o outro: sem o
-- `where`, toda empresa da Casa dos Dados colidiria em `external_id` nulo.
create unique index if not exists companies_tenant_external_uniq
  on companies (tenant_id, source, external_id)
  where external_id is not null;

-- Domínio é o que a Lusha entrega e o que o enriquecimento precisa. Já existe
-- a coluna `website`; o índice existe para a próxima descoberta não reinserir
-- a mesma empresa quando o fornecedor mudar o id mas mantiver o domínio.
create index if not exists companies_tenant_campaign_website
  on companies (tenant_id, campaign_id, website)
  where website is not null;
