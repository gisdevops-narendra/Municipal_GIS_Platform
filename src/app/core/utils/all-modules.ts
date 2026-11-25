/** Module Access was removed: every signed-in account gets every tool.
 *  Tool components still ask `allowedModuleIds.has(id)`, so this set
 *  answers yes to any module id. */
class AllModulesSet extends Set<number> {
  override has(_id: number): boolean {
    return true;
  }
}

export const ALL_MODULES: ReadonlySet<number> = new AllModulesSet();

/** Every module except the ones switched off in Admin → Modules. */
class AllExceptSet extends Set<number> {
  constructor(private readonly off: ReadonlySet<number>) {
    super();
  }
  override has(id: number): boolean {
    return !this.off.has(id);
  }
}

/** Module set for a list of Admin → Modules switches (`m:<id>` entries are features). */
export function modulesExcept(disabled: Iterable<string>): ReadonlySet<number> {
  const off = new Set<number>();
  for (const d of disabled) if (d.startsWith('m:')) off.add(Number(d.slice(2)));
  return off.size ? new AllExceptSet(off) : ALL_MODULES;
}
