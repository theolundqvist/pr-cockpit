<script>
  import { untrack } from "svelte";
  import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
  import { javascript } from "@codemirror/lang-javascript";
  import { bracketMatching, indentOnInput } from "@codemirror/language";
  import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
  import { Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, ViewPlugin } from "@codemirror/view";
  import { ensureTheme, getHighlighter, langForPath, tokenizeCode } from "./highlight.js";
  import { theme } from "./theme.svelte.js";

  let { content = $bindable(), path, initialLine = 1, initialColumn = 0, rowOffset = 0, layout = "unified" } = $props();
  let host;
  let editor;
  let shikiTheme;

  const shikiCompartment = new Compartment();

  const setShikiDecorations = StateEffect.define();
  const shikiDecorations = StateField.define({
    create: () => Decoration.none,
    update(decorations, transaction) {
      decorations = decorations.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (effect.is(setShikiDecorations)) decorations = effect.value;
      }
      return decorations;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  function languageForPath(path) {
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"].includes(extension)) {
      return javascript({ typescript: ["ts", "tsx", "mts", "cts"].includes(extension), jsx: ["jsx", "tsx"].includes(extension) });
    }
    return [];
  }

  const SHIKI_VISIBLE_TEXT_BUDGET = 20_000;

  function browserVisibleLineRange(view) {
    const editorRect = view.dom.getBoundingClientRect();
    const left = Math.max(0, editorRect.left);
    const right = Math.min(window.innerWidth, editorRect.right);
    const top = Math.max(0, editorRect.top);
    const bottom = Math.min(window.innerHeight, editorRect.bottom);
    if (right <= left || bottom <= top) return null;

    const contentRect = view.contentDOM.getBoundingClientRect();
    const x = Math.max(left, Math.min(right - 1, contentRect.left + 1));
    const from = view.posAtCoords({ x, y: top + 0.5 }, false);
    const to = view.posAtCoords({ x, y: bottom - 0.5 }, false);
    if (from === null || to === null) return null;
    return {
      first: view.state.doc.lineAt(Math.min(from, to)).number,
      last: view.state.doc.lineAt(Math.max(from, to)).number,
    };
  }
  function shikiHighlighting(path, themeName) {
    const lang = langForPath(path);
    if (!lang) return [];

    let idle = null;
    let generation = 0;
    let destroyed = false;
    const ready = getHighlighter().then(async (highlighter) => {
      await ensureTheme(highlighter, themeName);
      return highlighter;
    });

    function cancelScheduled() {
      if (idle === null) return;
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      else clearTimeout(idle);
      idle = null;
    }

    function schedule(view) {
      const request = ++generation;
      cancelScheduled();
      ready.then((highlighter) => {
        if (destroyed || request !== generation) return;
        const run = () => {
          idle = null;
          if (destroyed || request !== generation) return;
          const ranges = [];
          const visible = browserVisibleLineRange(view);
          let remaining = SHIKI_VISIBLE_TEXT_BUDGET;
          if (visible) {
            for (let number = visible.first; number <= visible.last; number++) {
              const line = view.state.doc.line(number);
              if (line.length > SHIKI_VISIBLE_TEXT_BUDGET) continue;
              if (line.length > remaining) break;
              remaining -= line.length;
              const tokens = tokenizeCode(highlighter, line.text, lang, themeName)[0] ?? [];
              let offset = 0;
              for (const token of tokens) {
                const from = line.from + offset;
                offset += token.content.length;
                if (token.color && offset > from - line.from) {
                  ranges.push(Decoration.mark({ attributes: { style: `color:${token.color}` } }).range(from, line.from + offset));
                }
              }
            }
          }
          if (!destroyed && request === generation) {
            view.dispatch({ effects: setShikiDecorations.of(Decoration.set(ranges, true)) });
          }
        };
        idle =
          typeof requestIdleCallback === "function"
            ? requestIdleCallback(run, { timeout: 160 })
            : setTimeout(run, 80);
      });
    }

    return [
      shikiDecorations,
      ViewPlugin.define((view) => {
        const onBrowserViewportChange = () => schedule(view);
        window.addEventListener("scroll", onBrowserViewportChange, true);
        window.addEventListener("resize", onBrowserViewportChange);
        schedule(view);
        return {
          update(update) {
            if (update.docChanged || update.viewportChanged) schedule(update.view);
          },
          destroy() {
            window.removeEventListener("scroll", onBrowserViewportChange, true);
            window.removeEventListener("resize", onBrowserViewportChange);
            destroyed = true;
            generation++;
            cancelScheduled();
          },
        };
      }),
    ];
  }

  $effect(() => {
    if (!host) return;
    shikiTheme = untrack(() => theme.shiki);
    editor = new EditorView({
      state: EditorState.create({
        doc: untrack(() => content),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ "aria-label": `Edit ${path}`, spellcheck: "false" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) content = update.state.doc.toString();
          }),
          languageForPath(path),
          shikiCompartment.of(shikiHighlighting(path, shikiTheme)),
        ],
      }),
      parent: host,
    });

    const line = editor.state.doc.line(Math.max(1, Math.min(initialLine, editor.state.doc.lines)));
    const caret = Math.min(line.to, line.from + Math.max(0, initialColumn));
    editor.dispatch({ selection: { anchor: caret } });
    editor.requestMeasure({
      read(view) {
        return view.lineBlockAt(caret).top;
      },
      write(lineTop, view) {
        view.scrollDOM.scrollTop = Math.max(0, lineTop - Math.max(0, rowOffset));
        view.contentDOM.focus({ preventScroll: true });
      },
    });

    return () => {
      editor.destroy();
      editor = undefined;
    };
  });

  $effect(() => {
    const themeName = theme.shiki;
    if (!editor || themeName === shikiTheme) return;
    shikiTheme = themeName;
    editor.dispatch({ effects: shikiCompartment.reconfigure(shikiHighlighting(path, themeName)) });
  });

  $effect(() => {
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (content === current) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: content } });
  });
</script>

<div class="code-editor" class:unified={layout === "unified"} bind:this={host}></div>

<style>
  .code-editor {
    flex: 1;
    min-width: 0;
    height: 100%;
    background: var(--panel);
  }
  .code-editor :global(.cm-editor) {
    height: 100%;
    color: var(--text);
    background: var(--panel);
    font-family: var(--code-font);
    font-size: var(--diff-font-size);
    line-height: 1.6;
  }
  .code-editor :global(.cm-editor.cm-focused) {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--link);
  }
  .code-editor :global(.cm-scroller) {
    overflow: auto;
    font-family: var(--code-font);
    line-height: 1.6;
    overscroll-behavior: contain;
  }
  .code-editor :global(.cm-content) {
    padding: 0;
    caret-color: var(--text);
  }
  .code-editor :global(.cm-line) {
    padding: 0 16px 0 0;
  }
  .code-editor :global(.cm-gutters) {
    min-height: 100%;
    width: 66px;
    border: none;
    background: var(--ln-tint);
    color: var(--text-faint);
  }
  .code-editor :global(.cm-lineNumbers) {
    width: 46px;
  }
  .code-editor :global(.cm-lineNumbers .cm-gutterElement) {
    min-width: 46px;
    padding: 0 8px;
    text-align: right;
  }
  .code-editor.unified :global(.cm-gutters) {
    width: 112px;
  }
  .code-editor.unified :global(.cm-lineNumbers) {
    width: 92px;
  }
  .code-editor.unified :global(.cm-lineNumbers .cm-gutterElement) {
    min-width: 92px;
  }
  .code-editor :global(.cm-activeLine) {
    background: color-mix(in srgb, var(--hunk-hover) 55%, transparent);
  }
  .code-editor :global(.cm-activeLineGutter) {
    background: transparent;
  }
  .code-editor :global(.cm-selectionBackground),
  .code-editor :global(.cm-content ::selection) {
    background: var(--link-bg-hover) !important;
  }
</style>
