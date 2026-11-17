import type { Repo } from './repo.js';

export type Change<T> = { kind: 'put'; doc: T } | { kind: 'remove'; doc: T };

/**
 * A repo that tells a listener about every document written to it or removed from it, whoever does the writing.
 * (The search index keeps itself current this way.)
 */
export function observe<T extends { id: string }>(repo: Repo<T>, notify: (c: Change<T>) => void): Repo<T> {
  return {
    insert: (doc) => {
      const d = repo.insert(doc);
      notify({ kind: 'put', doc: d });
      return d;
    },
    save: (doc) => {
      const d = repo.save(doc);
      notify({ kind: 'put', doc: d });
      return d;
    },
    saveQuiet: (doc) => {
      const d = repo.saveQuiet(doc);
      notify({ kind: 'put', doc: d });
      return d;
    },
    get: (id) => repo.get(id),
    findOne: (q) => repo.findOne(q),
    find: (q) => repo.find(q),
    where: (fn) => repo.where(fn),
    count: (q) => repo.count(q),
    remove: (doc) => {
      repo.remove(doc);
      notify({ kind: 'remove', doc });
    },
    removeWhere: (fn) => {
      const hit = repo.where(fn);
      for (const d of hit) {
        repo.remove(d);
        notify({ kind: 'remove', doc: d });
      }
      return hit.length;
    },
    insertRaw: (doc) => {
      repo.insertRaw(doc);
      notify({ kind: 'put', doc });
    },
  };
}
