import { parseNiche } from "../src/ai/niche-parser.js";

const filtros = await parseNiche(
  "indústrias de alimentos em Santa Catarina com mais de 50 funcionários, quero falar com o gerente de TI",
);
console.log(JSON.stringify(filtros, null, 2));
