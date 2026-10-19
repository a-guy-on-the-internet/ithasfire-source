export function shouldShowManageRolesLink(eventId: string, slug?: string) {
  return Boolean(eventId && slug);
}
