-- A deduplicação de empresas passa a ser POR CAMPANHA.
--
-- Os dois índices eram por tenant. Consequência: a segunda campanha do mesmo
-- tenant, mirando um perfil parecido, descobre as mesmas empresas, todas
-- colidem com as que já estão gravadas para a primeira, e NADA é salvo. A
-- tela mostra "0 nova(s) salva(s)" e a campanha nova nasce vazia sem que
-- nada tenha dado errado — que é o pior tipo de defeito.
--
-- `companies` é a lista de alvos DAQUELA campanha, não o cadastro de
-- empresas do tenant. Duas campanhas com ofertas diferentes miram a mesma
-- indústria legitimamente.
--
-- O que impede contatar a mesma pessoa duas vezes continua existindo, e é
-- outro mecanismo: a lista de supressão, que é por tenant e age na última
-- milha do envio. Deduplicar empresa aqui nunca foi essa proteção — só
-- parecia ser.

drop index if exists companies_tenant_cnpj_uniq;
create unique index if not exists companies_tenant_campanha_cnpj_uniq
  on companies (tenant_id, campaign_id, cnpj)
  where cnpj is not null;

drop index if exists companies_tenant_external_uniq;
create unique index if not exists companies_tenant_campanha_external_uniq
  on companies (tenant_id, campaign_id, source, external_id)
  where external_id is not null;
