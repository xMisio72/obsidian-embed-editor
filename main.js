/*
 * Synced Edit — click-to-edit panel for transcluded embeds
 * Click any ![[]] embed to edit its source content in a floating modal.
 */

const obsidian = require("obsidian");

class SyncedEditModal extends obsidian.Modal {
  constructor(app, sourcePath, subpath, content, startLine, endLine) {
    super(app);
    this.sourcePath = sourcePath;
    this.subpath = subpath;
    this.originalContent = content;
    this.startLine = startLine;
    this.endLine = endLine;
    this.isDirty = false;
    this.modalEl.addClass("synced-edit-modal");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // Header — show source file + section
    const header = contentEl.createDiv({ cls: "synced-edit-header" });
    const sourceLabel = header.createSpan({ cls: "synced-edit-source-link" });
    const displayName = this.sourcePath.replace(/\.md$/, "");
    sourceLabel.textContent = this.subpath
      ? `${displayName} → ${this.subpath}`
      : displayName;
    sourceLabel.addEventListener("click", () => {
      const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
      if (file) {
        this.app.workspace.getLeaf(false).openFile(file);
        this.close();
      }
    });

    const headerRight = header.createDiv({ cls: "synced-edit-header-right" });
    const dirtyDot = headerRight.createSpan({ cls: "synced-edit-dirty-dot" });
    this.dirtyDot = dirtyDot;
    const shortcutHint = headerRight.createSpan({ cls: "synced-edit-shortcut-hint" });
    shortcutHint.textContent = "Ctrl+Enter to save";

    // Editor area
    const editorWrap = contentEl.createDiv({ cls: "synced-edit-editor-wrap" });
    const textarea = editorWrap.createEl("textarea", { cls: "synced-edit-textarea" });
    textarea.value = this.originalContent;
    textarea.spellcheck = false;
    this.textarea = textarea;

    // Auto-resize textarea
    const autoResize = () => {
      textarea.style.height = "auto";
      textarea.style.height = textarea.scrollHeight + "px";
    };

    textarea.addEventListener("input", () => {
      this.isDirty = textarea.value !== this.originalContent;
      this.dirtyDot.toggleClass("is-dirty", this.isDirty);
      autoResize();
    });

    // Tab key inserts a tab instead of moving focus
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + "\t" + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 1;
        textarea.dispatchEvent(new Event("input"));
      }
    });

    // Footer with save/cancel
    const footer = contentEl.createDiv({ cls: "synced-edit-footer" });

    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = footer.createEl("button", {
      text: "Save",
      cls: "synced-edit-btn-save",
    });
    saveBtn.addEventListener("click", () => this.save());

    // Keyboard shortcuts
    this.scope.register(["Mod"], "Enter", () => {
      this.save();
      return false;
    });

    this.scope.register([], "Escape", () => {
      this.close();
      return false;
    });

    // Focus and initial render
    setTimeout(() => {
      textarea.focus();
      autoResize();
    }, 50);
  }

  async save() {
    if (!this.isDirty) {
      this.close();
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!file) {
      new obsidian.Notice(`Source file not found: ${this.sourcePath}`);
      return;
    }

    try {
      const fullContent = await this.app.vault.read(file);
      const lines = fullContent.split("\n");

      const newLines = this.textarea.value.split("\n");
      lines.splice(this.startLine, this.endLine - this.startLine, ...newLines);

      await this.app.vault.modify(file, lines.join("\n"));
      new obsidian.Notice("Synced edit saved");
      this.close();
    } catch (e) {
      new obsidian.Notice(`Save failed: ${e.message}`);
      console.error("Synced Edit save error:", e);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class SyncedEditPlugin extends obsidian.Plugin {
  async onload() {
    console.log("Synced Edit: loaded");

    this.registerDomEvent(document, "click", (evt) => {
      this.handleEmbedClick(evt);
    });

    this.registerMarkdownPostProcessor((el) => {
      const embeds = el.querySelectorAll(".markdown-embed");
      embeds.forEach((embed) => {
        embed.addClass("synced-edit-hover");
      });
    });

    this.tagExistingEmbeds();
  }

  tagExistingEmbeds() {
    document.querySelectorAll(".markdown-embed").forEach((el) => {
      el.addClass("synced-edit-hover");
    });
  }

  handleEmbedClick(evt) {
    const embedEl = evt.target.closest(".markdown-embed");
    if (!embedEl) return;

    if (evt.target.closest("a, button, input, .internal-link, .external-link")) {
      return;
    }

    const src = this.getEmbedSource(embedEl);
    if (!src) return;

    evt.preventDefault();
    evt.stopPropagation();

    this.openEditor(src.path, src.subpath);
  }

  getEmbedSource(embedEl) {
    let src = embedEl.getAttribute("src");

    if (!src) {
      const linkEl = embedEl.querySelector(".markdown-embed-link");
      if (linkEl) {
        src = linkEl.getAttribute("src") || linkEl.getAttribute("data-href");
      }
    }

    if (!src) {
      const internal = embedEl.closest(".internal-embed");
      if (internal) {
        src = internal.getAttribute("src");
      }
    }

    if (!src) {
      let node = embedEl;
      while (node && !src) {
        src = node.getAttribute("src") || node.getAttribute("alt");
        node = node.parentElement;
      }
    }

    if (!src) return null;

    let path = src;
    let subpath = null;

    const hashIdx = src.indexOf("#");
    if (hashIdx !== -1) {
      path = src.substring(0, hashIdx);
      subpath = src.substring(hashIdx + 1);
    }

    const activeFile = this.app.workspace.getActiveFile();
    const resolved = this.app.metadataCache.getFirstLinkpathDest(
      path,
      activeFile ? activeFile.path : ""
    );

    if (!resolved) return null;

    return { path: resolved.path, subpath };
  }

  async openEditor(filePath, subpath) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) {
      new obsidian.Notice(`File not found: ${filePath}`);
      return;
    }

    const fullContent = await this.app.vault.read(file);
    const lines = fullContent.split("\n");

    let startLine = 0;
    let endLine = lines.length;
    let extractedContent = fullContent;

    if (subpath) {
      const range = this.resolveSubpath(lines, subpath, filePath);
      if (range) {
        startLine = range.start;
        endLine = range.end;
        extractedContent = lines.slice(startLine, endLine).join("\n");
      }
    }

    const modal = new SyncedEditModal(
      this.app,
      filePath,
      subpath,
      extractedContent,
      startLine,
      endLine
    );
    modal.open();
  }

  resolveSubpath(lines, subpath, filePath) {
    if (subpath.startsWith("^")) {
      const blockId = subpath.substring(1);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(`^${blockId}`)) {
          return { start: i, end: i + 1 };
        }
      }
      return null;
    }

    const heading = subpath;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    const cache = this.app.metadataCache.getFileCache(file);

    if (cache && cache.headings) {
      for (let i = 0; i < cache.headings.length; i++) {
        const h = cache.headings[i];
        if (h.heading === heading) {
          const startLine = h.position.start.line;
          const level = h.level;

          let endLine = lines.length;
          for (let j = i + 1; j < cache.headings.length; j++) {
            if (cache.headings[j].level <= level) {
              endLine = cache.headings[j].position.start.line;
              break;
            }
          }

          return { start: startLine, end: endLine };
        }
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(#{1,6})\s+(.*)/);
      if (match && match[2].trim() === heading) {
        const level = match[1].length;
        let endLine = lines.length;

        for (let j = i + 1; j < lines.length; j++) {
          const nextMatch = lines[j].match(/^(#{1,6})\s/);
          if (nextMatch && nextMatch[1].length <= level) {
            endLine = j;
            break;
          }
        }

        return { start: i, end: endLine };
      }
    }

    return null;
  }

  onunload() {
    console.log("Synced Edit: unloaded");
    document.querySelectorAll(".synced-edit-hover").forEach((el) => {
      el.removeClass("synced-edit-hover");
    });
  }
}

module.exports = SyncedEditPlugin;
