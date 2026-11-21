import pathlib
import re
import subprocess
import sys

ninja, output, phase, shard_count, suffix = sys.argv[1:]
shard, shards = int(phase), int(shard_count)
if not 1 <= shard <= shards:
    raise ValueError('Shard out of range')
node = re.compile(r'^"0x[0-9a-f]+" \[label="([^"\r\n]+)"\]$', re.I)
with subprocess.Popen([ninja, '-C', output, '-t', 'graph', 'electron', 'electron:electron_dist_zip'],
                      stdout=subprocess.PIPE, text=True, encoding='utf-8') as process:
    objects = {match[1] for row in process.stdout if (match := node.match(row.rstrip()))
               and match[1].lower().endswith(suffix)}
    if process.wait():
        raise RuntimeError('Ninja could not produce the graph')
if len(objects) < 1000:
    raise RuntimeError(f'Unexpectedly small Windows build graph: {len(objects)} objects')
def escape_target(target):
    return target.replace('$', '$$').replace(' ', '$ ').replace(':', '$:')
selected = [escape_target(target) for target in sorted(objects)[shard - 1::shards]]
path = pathlib.Path(output) / 'pilion-native-shard.ninja'
path.write_text('include build.ninja\nbuild pilion_shard: phony ' + ' '.join(selected) + '\n', encoding='utf-8')
print(f'Shard {shard}/{shards}: {len(selected)} of {len(objects)} objects')
