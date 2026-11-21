/** Module Access was removed: every signed-in account gets every tool.
 *  Tool components still ask `allowedModuleIds.has(id)`, so this set
 *  answers yes to any module id. */
class AllModulesSet extends Set<number> {
  override has(_id: number): boolean {
    return true;
  }
}

export const ALL_MODULES: ReadonlySet<number> = new AllModulesSet();
