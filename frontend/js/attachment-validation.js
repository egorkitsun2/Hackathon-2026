export function validateAttachment(file) {
  if (!file || file.size < 1) return 'attachmentRequired';
  if (file.size > 5 * 1024 * 1024) return 'attachmentTooLarge';
  if (!/\.(jpe?g|png|webp|pdf)$/i.test(file.name)) return 'attachmentUnsupported';
  if (Array.from(file.name).length > 180 || new TextEncoder().encode(file.name).length > 255
    || /[\\/:\x00-\x1f\x7f]/.test(file.name)) return 'attachmentInvalid';
  return '';
}

