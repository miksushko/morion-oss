import type { Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import {
  Bold,
  Italic,
  Strikethrough,
  Code as CodeIcon,
  Link as LinkIcon,
  Heading1,
  Heading2,
  Heading3,
  Quote as QuoteIcon,
} from 'lucide-react';
import { ToolbarButton } from './ToolbarButton';

interface EditorToolbarProps {
  editor: Editor;
}

/**
 * BubbleMenu shown on text selection. Hosts heading + inline formatting
 * + link controls. Extracted from `../TiptapEditor.tsx` (2026-05-16,
 * ticket `01KRQYTJYX3NWJW5E1S4V1FDZ9`).
 */
export function EditorToolbar({ editor }: EditorToolbarProps) {
  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: 'top' }}
      className="flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 shadow-md"
    >
      <ToolbarButton
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        label="Heading 1"
      >
        <Heading1 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        label="Heading 2"
      >
        <Heading2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        label="Heading 3"
      >
        <Heading3 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <div className="mx-0.5 h-4 w-px bg-border" aria-hidden />
      <ToolbarButton
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
        label="Bold"
      >
        <Bold className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        label="Italic"
      >
        <Italic className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        label="Strike"
      >
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
        label="Inline code"
      >
        <CodeIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        label="Quote"
      >
        <QuoteIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('link')}
        onClick={() => {
          const prev = (editor.getAttributes('link').href as string) ?? '';
          const href = window.prompt('Link URL', prev);
          if (href === null) return;
          if (href === '') {
            editor.chain().focus().extendMarkRange('link').unsetLink().run();
            return;
          }
          editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
        }}
        label="Link"
      >
        <LinkIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
    </BubbleMenu>
  );
}
