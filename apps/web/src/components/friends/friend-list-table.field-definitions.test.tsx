// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FriendListItem } from '@/lib/api';

const captured = vi.hoisted(() => ({ references: [] as unknown[] }));

vi.mock('@/lib/api', () => ({
  api: { friends: { addTag: vi.fn(), removeTag: vi.fn() } },
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('./friend-list-row', () => ({
  default: ({ onTagEditClick }: { onTagEditClick: () => void }) => (
    <button type="button" onClick={onTagEditClick}>展開</button>
  ),
}));

vi.mock('./custom-metadata-editor', () => ({
  default: (props: { fieldDefinitions?: unknown }) => {
    captured.references.push(props.fieldDefinitions);
    return <div>metadata editor</div>;
  },
}));

import FriendListTable from './friend-list-table';

afterEach(() => {
  cleanup();
  captured.references.length = 0;
});

const friend: FriendListItem = {
  id: 'fr-1',
  lineUserId: 'U1',
  displayName: '友だちA',
  pictureUrl: null,
  statusMessage: null,
  isFollowing: true,
  createdAt: '2026-07-19',
  updatedAt: '2026-07-19',
  tags: [],
};

describe('FriendListTable fieldDefinitions default', () => {
  test('友だち詳細のカスタム欄から全員共通の設定へ移動できる', () => {
    render(<FriendListTable friends={[friend]} allTags={[]} onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '展開' }));

    const link = screen.getByRole('link', { name: /全員共通のカスタムフィールドはこちら/ });
    expect(link.getAttribute('href')).toBe('/friends#friend-custom-fields');
  });

  test('props 未指定の空配列は親 rerender をまたいで同じ参照を保つ', () => {
    const { rerender } = render(
      <FriendListTable friends={[friend]} allTags={[]} onRefresh={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '展開' }));
    const first = captured.references.at(-1);
    expect(Array.isArray(first)).toBe(true);

    rerender(<FriendListTable friends={[friend]} allTags={[]} onRefresh={vi.fn()} />);
    expect(captured.references.at(-1)).toBe(first);
  });
});
