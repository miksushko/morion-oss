export interface AppleNotesFolder {
  /** Account display name (e.g. "iCloud", "On My Mac"). */
  accountName: string;
  /** Folder display name. */
  folderName: string;
  /** Slash-separated path within the account, e.g. "Projects/Foo".
   *  Top-level folders have folderPath equal to folderName. */
  folderPath: string;
  /** Number of notes (excluding locked) in this folder. */
  noteCount: number;
}

export interface AppleNotesNote {
  accountName: string;
  folderPath: string;
  /** Note title from Apple Notes (`name of note`). */
  name: string;
  /** Raw HTML body — caller converts to markdown via `htmlToMarkdown`. */
  bodyHtml: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  modifiedAt: number;
  pinned: boolean;
}

export interface AppleNotesExportResult {
  notes: AppleNotesNote[];
  /** Folder paths that AppleScript reported but had locked / unreadable
   *  notes. Surfaced as warnings in the import summary. */
  skippedLocked: Array<{ accountName: string; folderPath: string; count: number }>;
}

export class AppleNotesPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleNotesPermissionError';
  }
}

export class AppleNotesNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleNotesNotInstalledError';
  }
}
