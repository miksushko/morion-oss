/** Tags domain types — workspace-wide labels attached to notes. */

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  noteCount: number;
}
