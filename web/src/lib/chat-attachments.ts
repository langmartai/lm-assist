import type { ChatAttachment } from '@/hooks/useChatConversation';

const TEXT_RE = /^text\/|application\/(json|xml|javascript|typescript|x-yaml|x-sh)|\+(json|xml)$/i;
const TEXT_EXT = /\.(txt|md|markdown|json|ya?ml|csv|tsv|log|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|cc|cs|php|sh|bash|sql|html?|css|xml|toml|ini|env|conf)$/i;

/** True when a file is safe to send inline as extracted text. */
export function isTextFile(file: File): boolean {
  if (file.type && TEXT_RE.test(file.type)) return true;
  if (!file.type && TEXT_EXT.test(file.name)) return true;
  return TEXT_EXT.test(file.name);
}

/** Read a text file's content and build a completion `attachments` entry. Throws
 *  for non-text files (image/binary are deferred — the caller shows a chip error). */
export async function fileToChatAttachment(file: File): Promise<ChatAttachment> {
  if (!isTextFile(file)) throw new Error('Only text files can be attached to chat right now');
  const extracted_content = await file.text();
  return {
    file_name: file.name,
    file_type: file.type || 'text/plain',
    file_size: file.size,
    extracted_content,
    origin: 'user_upload',
    kind: 'file',
  };
}
