const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

/** Sorts like Finder/Explorer: "2" before "10". */
export function naturalSort<T>(items: T[], key: (x: T) => string): T[] {
  return [...items].sort((a, b) => collator.compare(key(a), key(b)))
}
