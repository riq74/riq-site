# riq-site
Site do Riq

riq.ia.br
meu espaço pessoal na internet.
a ideia é simples: uma página inicial que funciona como hub para os projetos que vou criando. não tem tema fixo, não tem regra | pode ser uma ferramenta, um jogo, um experimento, qualquer coisa que eu quis construir.
alguns projetos são úteis, outros são só curiosidade mesmo.


stack
html, css e js puro na página principal. os projetos internos variam conforme o que fizer mais sentido pra cada um.
hospedado no github pages.

## Desenhe seu Caminho

O editor está em `desenhe-seu-caminho/`. Essa pasta contém o build estático que acompanha o site. O código-fonte continua em `Documents/¹Pessoal/Test-MAP/app`.

Para atualizar o editor, rode no projeto fonte, com as dependências instaladas:

```sh
npm run build -- --mode riq --base ./ --outDir ../../../riq-site/desenhe-seu-caminho --emptyOutDir
```

O modo `riq` usa rotas com fragmento para reabrir projetos e páginas de ajuda ao recarregar no GitHub Pages. Sirva o site por HTTPS ou localhost para usar a exportação de vídeo.

contato

email: dev@riq.ia.br
instagram: @riq74_
linkedin: henrique-coelho01
