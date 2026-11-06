"""Three-way record merge. A client's last acknowledged snapshot is its base.

Unchanged stale records never overwrite a remote edit or resurrect a deletion.
Concurrent edits of the same record abort the entire transaction.
"""
from copy import deepcopy


class Conflict(ValueError):
    pass


def merge(base, local, remote):
    result = deepcopy(remote)
    for key in sorted(set(base) | set(local)):
        before, after, current = base.get(key), local.get(key), remote.get(key)
        if before == after:
            continue
        if current != before and current != after:
            raise Conflict(key)
        if after is None:
            result.pop(key, None)
        else:
            result[key] = deepcopy(after)
    return result


def periods_map(periods):
    return {p['start']: {'start': p['start'], 'end': p.get('end')} for p in periods}
