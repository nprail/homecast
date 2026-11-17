---
title: "Queries and indexes"
description: "Every operator, sorting and paging, result sets, aggregates, and how the planner picks an index."
---

# Queries and indexes

A query is an object of conditions that must all hold.

```ts
users.find({ role: 'user', createdAt: { $gt: since } });
users.find({ name: /^m/i, 'address.city': { $in: ['Lyon', 'Oslo'] } });
users.find({ $or: [{ role: 'admin' }, { age: { $lt: 18 } }] }, { sort: { age: -1 }, limit: 20 });
```

## Conditions on a field

`{ field: value }` is equality (strict; `null` also matches a missing field). A `RegExp` or a `Date` as the value matches by pattern or by moment. Otherwise the value is an object of operators.

| Operator | Matches |
|---|---|
| `$eq`, `$ne` | equal, not equal. Arrays and plain objects compare by value |
| `$aeq` | abstract equality (`==`): `1` matches `'1'` |
| `$gt`, `$gte`, `$lt`, `$lte` | a range. Numbers and dates compare as numbers, strings as strings; bounds of another type match nothing |
| `$between` | `[low, high]`, both ends included |
| `$in`, `$nin` | one of, none of |
| `$regex` | a `RegExp`, a pattern string, or `[pattern, flags]`. Strings only |
| `$containsString` | a string with this substring |
| `$contains` | an array holding the value (or every value of an array), a string with that substring, an object with that key |
| `$containsAny`, `$containsNone` | an array holding any of, none of these |
| `$type` | `typeof`, plus `'array'`, `'null'`, `'date'`; a missing field is `'undefined'` |
| `$exists` | `true` for present, `false` for missing |
| `$finite` | `true` for a finite number |
| `$size`, `$len` | the length of an array or string |
| `$dteq` | the same moment: a Date, an ISO string or a timestamp on either side |
| `$keyin`, `$nkeyin` | the field's value is (is not) a key of this object |
| `$definedin`, `$undefinedin` | this object has (has no) defined value under the field's value |
| `$jgt`, `$jgte`, `$jlt`, `$jlte`, `$jbetween` | plain JavaScript comparison, without regard to type |
| `$not` | negates operators: `{ age: { $not: { $gt: 30 } } }` |

Several operators on one field must all hold: `{ age: { $gt: 20, $lt: 30 } }`.

### Nested fields

A dotted path reaches into nested objects and array positions: `{ 'owner.name': 'Maya' }`. Dotted paths can be indexed too (`indexed: ['owner.name']`), and the index follows a change when you call `update`.

## Combining conditions

Several fields in one query are joined with "and". For anything else:

| | |
|---|---|
| `$and: [q, q]` | all of these |
| `$or: [q, q]` | at least one |
| `$nor: [q, q]` | none |
| `$not: q` | not this |
| `$where: fn` | a function over the document |

They nest as deep as you like. `$or` uses indexes for each branch, then merges.

## Sorting and paging

```ts
users.find(q, { sort: { createdAt: -1, name: 1 }, offset: 20, limit: 10 });
users.findOne(q, { sort: 'createdAt' });
```

`sort` is `{ field: 1 | -1 }` (or `'asc'` / `'desc'`) in key order, or a field name for ascending. Values of different types sort together as: missing and `null`, booleans, numbers and dates, strings, everything else. Ties are in no promised order.

**"The newest 20" is cheap.** With an ordered index on the sort field, docstore reads the first entries straight off the index, checking your query on each, and stops once it has enough. That is the same cost at ten thousand documents and at ten million. If the matches are rare it gives up after a bounded number of steps and does the usual thing: read the matches, then pick the best few. Both give the same answer.

## Result sets

`collection.chain()` starts a result set you narrow step by step, like Loki's.

```ts
users.chain()
  .find({ active: true })
  .where((u) => u.name.length > 3)
  .simplesort('createdAt', true)     // true for descending
  .offset(10).limit(5)
  .data();
```

| Method | |
|---|---|
| `find(q)`, `where(fn)` | keep matching documents (the first `find` uses the indexes) |
| `sort(fn)`, `simplesort(field, desc?)`, `compoundsort([['a'], ['b', true]])` | order |
| `limit(n)`, `offset(n)` | page |
| `copy()` | branch from here |
| `data()`, `count()`, `first()` | read |
| `update(fn \| object)`, `remove()` | change or delete every document in the set, and store the change |
| `map(fn)`, `mapReduce(map, reduce)` | reshape |
| `eqJoin(other, leftKey, rightKey, mapFn?)` | pair each document with the item of another list whose key equals its own |
| `extract(field)`, `extractNumerical(field)` | the field's values from every document |
| `avg`, `min`, `max`, `median`, `stdDev`, `mode` (field) | aggregates |

Every step produces its list at once; it is not lazy. For "the first N after sorting" use `find(q, { sort, limit })`, which is.

Collections also have shortcuts: `findAndUpdate(q, fnOrObject)`, `findAndRemove(q)`, `updateWhere(filterFn, changeFn)`, `removeWhere(qOrFn)`, `by(field, value)`, and the aggregates directly (`users.avg('age')`).

## How a query runs

1. Each condition is checked for an index that can answer it: `id`, a hash index (`unique` or `indexed`) for equality and `$in`, an ordered index for equality and ranges. Operators with no index (`$regex`, `$contains`, `$not`, ...) are checked on the documents the index returns.
2. With more than one candidate, the planner asks each index how many documents it would return and starts from the smallest. An `$or` counts as the sum of its branches. With only one candidate it does not count.
3. The documents from that index already satisfy that condition. The rest of the query is checked on them.
4. With no usable index the whole collection is scanned.

`count(query)` is answered from the index without touching documents when it can be. `max(field)` and `min(field)` on an ordered field are free: they are the ends of the index.

## Ordered indexes

List a field under `ordered` for ranges and for sorting without a scan. Numbers and dates go in one sorted list (a date is its timestamp) and strings in another, each a blocked sorted list (1,024 entries per block), so an insert or delete moves at most one block, never the whole index. A document whose value is neither (missing, `null`, a boolean, an object) is left out of the index; sorting by the field then reads all documents instead of the index, since the index would miss some.

Dates are objects in memory but become ISO strings after a save and reload, as with any JSON store. Store timestamps (numbers) in indexed date fields, or ISO strings throughout; do not mix.
