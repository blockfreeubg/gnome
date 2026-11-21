/** Types shared by the Bookmarks page and its dialogs. */

export interface SaveError {
  field: 'url' | 'folder';
  message: string;
}

export interface BookmarkDraft {
  kind: 'bookmark' | 'folder';
  title: string;
  url: string;
  parentId: string;
  favorite: boolean;
}
