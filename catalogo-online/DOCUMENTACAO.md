# DOCUMENTAÇÃO TÉCNICA — Catálogo de Peças Online

## 1. VISÃO GERAL DO PROJETO

**Nome do arquivo:** `catalogo-pecas-movendo-final.html`
**Tipo:** Aplicação web single-page (1 arquivo HTML autônomo)
**Linhas:** ~1695
**Dependências externas:** ZERO (tudo inline)
**Módulo OCR:** Removido completamente (Gemini + Ollama)

**O que o programa faz:** Editor de catálogo de peças automotivas que permite criar páginas com cards de peças (SAPATA ou COMPONENTE), adicionar fotos, importar dados via JSON, e gerar PDF de alta qualidade (2480×3508px = A4 em 300 DPI).

---

## 2. ARQUITETURA DO CÓDIGO

O código é 100% HTML + CSS + JavaScript vanilla. Tudo em um único arquivo. Sem build, bundler, servidor, nem banco de dados. Estado em memória RAM do navegador.

### 2.1 Estrutura do arquivo (de cima para baixo)

| Seção | Linhas | O que contém |
|---|---|---|
| `<style>` | 8–173 | CSS completo (variáveis CSS, layout, modais, componentes, responsivo) |
| `<body>` HTML | 175–330 | Top bar, tips bar, container de páginas, modais (crop, import, restore, photo panel) |
| `<script>` | 331–1695 | Todo o JavaScript da aplicação |

### 2.2 Seções do JavaScript

| Seção | Descrição |
|---|---|
| **CONSTANTS** | `RED`, `DARK`, `PDF_W`(2480), `PDF_H`(3508), `ITEMS_PER_PAGE`(5) |
| **STATE** | Objeto `S` — `S.pages[]`, `S.drag`, `S.pdfLoading` |
| **UTILITIES** | `gid()`, `esc()`, `defaultItem()`, `defaultPage()`, `getPage()`, `getItem()`, `setStatus()`, `updateCounter()`, `normalizePages()` |
| **RENDERING** | `renderAll()`, `renderPage()`, `renderItem()`, `renderComponenteItem()` |
| **INPUT HANDLERS** | `onItemField()`, `onPageField()` |
| **STRUCTURAL MUTATIONS** | `addPage()`, `removePage()`, `addItem()`, `removeItem()`, `copyItem()`, `moveUp()`, `moveDown()`, `moveToPage()`, `movePageUp()`, `movePageDown()`, `movePageTo()` |
| **PHOTO PANEL** | `showPhotoPanel()`, `ppRender()`, `ppSetFreio()`, `closePhotoPanel()`, `closePhotoPanelNoSave()` |
| **IMAGE HANDLING** | `setImg()`, `onImgSlotClick()`, `onImgFile()`, `triggerLogo()`, `onLogoFile()` |
| **DRAG AND DROP** | `onDragStart()`, `onDragEnd()`, `handleDrop()` |
| **FILL METER** | `updateFillMeter()` |
| **LAYOUT CALCULATION** | `wrapText()`, `wrapTextComp()`, `calcLayout()`, `calcComponenteLayout()` |
| **PDF RENDERING** | `trunc()`, `rr()`, `preloadImgs()`, `drawCard()`, `drawComponenteCard()`, `renderPageCanvas()`, `generatePDF()` |
| **PDF BUILDER** | `buildPDF()` — PDF 1.4 raw binário |
| **BACKUP / RESTORE** | `saveBackup()`, `loadBackupFile()`, `showRestoreModal()`, `confirmRestore()` |
| **JSON IMPORT** | `parseImportJSON()`, `onImportChange()`, `confirmImport()` |
| **CROP EDITOR** | `CE` object — editor de imagem com corte e rotação |
| **INIT** | `DOMContentLoaded` → `CE.init()`, `defaultPage()`, `normalizePages()`, `renderAll()` |

---

## 3. MODELO DE DADOS (ESTADO)

### 3.1 Estado global `S`

```javascript
S = {
  pages: [
    {
      id: string,
      headerTitle: string,
      headerSubtitle: string,
      pageType: 'sapata' | 'componente',  // TIPO DA PÁGINA
      leftLogoUrl: string|null,
      rightLogoUrl: string|null,
      items: [
        {
          id: string,
          images: [string|null, string|null],
          lusarCode: string,
          nOriginal: string,
          similar: string,
          lonasLe: string,
          lonasLona: string,
          lonasThermoid: string,
          obs: string,
          freio: "Óleo"|"Ar",
          aplicacao: string,
          descricao: string
        }
      ]
    }
  ],
  drag: { id: string|null, fromPageId: string|null },
  pdfLoading: boolean
}
```

### 3.2 Backup (.catbak)

```json
{
  "version": 2,
  "savedAt": "ISO string",
  "pages": [ ... ]
}
```

- Exportado com JSON formatado (indentação 2 espaços)
- Inclui `pageType` para cada página
- Backups antigos sem `pageType` são normalizados para `'sapata'` via `normalizePages()`

---

## 4. FUNCIONALIDADES DETALHADAS

### 4.1 Gerenciamento de Páginas

- **SAPATA** (padrão): 1 card por linha, 5 itens por página, campos: FRAS-LE, LONAFLEX, THERMOID, Freio, Aplicação
- **COMPONENTE**: 2 cards por linha, altura fixa 35mm, campos: Nº Original, Nº Similar, Descrição
- Botão "+ Página" → SAPATA
- Botão "+ Página de Componentes" → COMPONENTE
- Páginas podem ser reordenadas (▲▼) ou movidas para outra posição (dropdown ↗)

### 4.2 Layout de Componentes

**Frontend (HTML):**
- Grid CSS 2 colunas com gap de 12px
- Cada componente: bloco esquerdo (imagem 80px + LUSAR) + separador + bloco direito (Nº Original, Nº Similar, Descrição)
- Altura mínima: 110px

**PDF:**
- 2 cards por linha, altura fixa 35mm
- Gap horizontal: 8mm, Gap vertical: 4mm
- Borda vermelha (igual sapata), linha separadora vermelha entre blocos
- Descrição com quebra de linha automática (`wrapTextComp`)
- Trunca palavras longas com `…` se excederem largura

### 4.3 Painel de Fotos

- Agrupa fotos por código LUSAR
- Botão "Cancelar" (fecha sem salvar) + "Fechar e Aplicar" (salva)
- Controle de "Freio: Óleo/Ar" aparece apenas para peças SAPATA (não para COMPONENTE)
- `PP.codeTypeMap` rastreia se cada código é sapata ou componente
- `closePhotoPanel()` propaga freio apenas para sapatas

### 4.4 Editor de Imagens (Crop)

- z-index: 600 (acima do painel de fotos que é 500)
- Rotação ±90°, corte por arraste, cantos redimensionáveis
- Fundo branco antes de desenhar (evita transparência virar preto)
- Pointer events para suporte touch

### 4.5 Geração de PDF

- `renderPageCanvas()` verifica `pg.pageType` e usa:
  - `calcLayout()` + `drawCard()` para SAPATA
  - `calcComponenteLayout()` + `drawComponenteCard()` para COMPONENTE
- `buildPDF()` constrói PDF 1.4 manualmente (sem biblioteca)
- Imagens JPEG qualidade 0.97

### 4.6 Fill Meter

- `updateFillMeter()` verifica `pg.pageType`
- SAPATA: cálculo por altura variável de texto
- COMPONENTE: cálculo por linhas × altura fixa

---

## 5. O QUE NÃO PODE SER MODIFICADO SEM RISCO DE QUEBRAR

### 5.1 Constantes críticas
- `PDF_W = 2480`, `PDF_H = 3508` — escala do PDF
- `ITEMS_PER_PAGE = 5` — apenas para SAPATA

### 5.2 Layout SAPATA
- `IMG_H = 32 * Sp`, `FY_AP_OFFSET`, `CARD_MAX_H = 48 * Sp`
- Renomear campos (`lonasLe`, `lonasLona`, `lonasThermoid`) exige mudar em ~6+ lugares

### 5.3 Layout COMPONENTE (PDF)
- `CARD_H = 35 * Sp` — altura fixa
- `GAP_X = 8 * Sp` — espaçamento entre blocos horizontais
- `GAP_Y = 4 * Sp` — espaçamento entre linhas
- `leftW = cardW * 0.35`, `rightW = cardW * 0.65` — proporção dos blocos
- `ctx.textAlign='left'` deve ser resetado após desenhar LUSAR (que usa `center`)

### 5.4 Estado global
- `S.pages[].items[].images` — array de 2 elementos
- IDs gerados por `gid()` usados como chaves de DOM

### 5.5 PDF Builder
- `buildPDF()` — estrutura binária raw, não alterar sem entender PDF 1.4

### 5.6 pageType
- Se ausente, `normalizePages()` assume `'sapata'`
- Não remover este campo

---

## 6. FLUXO DE INICIALIZAÇÃO

```
DOMContentLoaded
  ├── CE.init()          → pointer events no canvas de crop
  ├── S.pages = [defaultPage()]  → 1 página sapata com 1 item
  ├── normalizePages()   → garante pageType='sapata' em páginas antigas
  └── renderAll()        → gera HTML + fill meters
```

---

## 7. ARMAZENAMENTO

- Tudo em memória RAM
- localStorage: não utilizado
- Backup `.catbak`: JSON formatado (pretty-print, 2 espaços)
- Fotos como Data URLs (podem ficar grandes)

---

## 8. BUGS CORRETORES CONHECIDOS

1. **Botões de rádio Freio** — adicionados `data-page` e `data-item` para salvar corretamente
2. **`renderPage` ignorava componentes** — variável `itemsSection` agora é usada no return
3. **`drawComponenteCard` texto sobrepondo imagem** — `ctx.textAlign='left'` resetado após LUSAR
4. **Descrição longa ultrapassando card** — `wrapTextComp()` trunca palavras longas com `…`
5. **Fotos não aparecendo em componentes** — `setImg()` chama `renderAll()` se slot não existe
6. **Fill Meter errado para componentes** — usa `calcComponenteLayout()`
7. **Painel de fotos mostrando Freio para componentes** — `PP.codeTypeMap` filtra por tipo
8. **`<!DOCTYPE html>` duplicado** — removido
9. **Borda cinza fina no PDF de componentes** — alterada para vermelha, `lineWidth=3.5`

---

## 9. INSTRUÇÕES PARA IA ENTENDER O PROJETO

1. Arquivo único HTML/CSS/JS
2. Estado mutável em `S.pages`, `renderAll()` reconstrói tudo
3. `renderPage()` verifica `pg.pageType` para escolher layout
4. PDF: `renderPageCanvas()` → `calcLayout/calcComponenteLayout()` → `drawCard/drawComponenteCard()`
5. `wrapTextComp()` quebra linhas E trunca palavras longas
6. `normalizePages()` garante compatibilidade com backups antigos
7. `esc()` em todos os inputs para prevenir XSS

---

## 10. NOTAS PARA MANUTENÇÃO

- Para adicionar campo ao item: `defaultItem()`, `renderItem()`, `drawCard()`, `parseImportJSON()`
- Para componente: `renderComponenteItem()`, `drawComponenteCard()`, `calcComponenteLayout()`
- Para mudar itens por página SAPATA: alterar `ITEMS_PER_PAGE`
- Para mudar altura do componente: alterar `CARD_H` em `calcComponenteLayout()`
- Para mudar espaçamento entre blocos: alterar `GAP_X` em `calcComponenteLayout()`

---

Fim da documentação.
