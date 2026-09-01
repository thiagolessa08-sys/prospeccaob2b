-- O ponto de entrada do produto passa a ser o propósito da solução vendida,
-- em texto livre. A IA deriva dele o nicho, os cargos-alvo e o discurso do
-- e-mail; a pessoa refina; só depois o funil dispara.
--
-- Todas as colunas são anuláveis: as campanhas que já existem foram criadas
-- pelo caminho antigo (nicho e oferta escritos à mão) e continuam válidas.
-- `proposal_approved_at is null` significa "sem proposta aprovada", que é o
-- estado tanto de quem nunca propôs quanto de quem ainda está refinando.

-- O texto livre que a pessoa escreveu. Guardado mesmo depois de aprovado,
-- porque é a partir dele que se pede uma proposta nova quando a primeira não
-- convence — sem obrigar a redigitar.
alter table campaigns add column solution_purpose text;

-- A proposta da IA enquanto está em revisão, já com as edições da pessoa.
-- Rascunho: nada aqui afeta o funil.
alter table campaigns add column proposal jsonb;

-- Nulo enquanto a proposta não foi aprovada.
alter table campaigns add column proposal_approved_at timestamptz;

-- O briefing que guia o escritor de e-mail: ângulo, dores, provas e o que
-- evitar. Coluna separada de `proposal` de propósito — `proposal` é rascunho
-- editável, e isto é o que a IA lê de verdade na hora de escrever. Sem a
-- separação, uma edição não aprovada mudaria o e-mail que já está saindo.
alter table campaigns add column pitch_briefing jsonb;
