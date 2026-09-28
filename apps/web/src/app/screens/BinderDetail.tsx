import type { ReactElement } from 'react';
import type { BinderSearch } from '../routes/search-params';
import { BinderView, type BinderViewProps } from './binders/BinderView';

/** Keyed by binder: everything held only on screen (a picked-up card, an unsubmitted
 * page-jump value, in-flight search results, open tools) belongs to one binder and is
 * thrown away the moment another binder opens, however it was opened. */
export function BinderDetail({
  binderId,
  search,
  onSearch,
  onOpenLibrary,
}: {
  binderId: string;
  search: BinderSearch;
} & Omit<BinderViewProps, 'binderId' | 'search'>): ReactElement {
  return (
    <BinderView
      key={binderId}
      binderId={binderId}
      search={search}
      onSearch={onSearch}
      onOpenLibrary={onOpenLibrary}
    />
  );
}
