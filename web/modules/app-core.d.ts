// Declarations for the router surface the tests import (the rest of app-core.js is untyped).
export function registerPage(name: string, hooks?: { enter?: (() => unknown) | null; leave?: ((arg: { to: string }) => unknown) | null; lazy?: boolean; domId?: string | null }): void
export function registerAlias(from: string, to: string, before?: (() => void) | null): void
export function switchPage(pageId: string): void
export function setPageGuard(fn: ((pageId: string) => boolean) | null): void
export function getCurrentPage(): string | null
