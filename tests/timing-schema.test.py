"""Run with: uv run --with jsonschema python tests/timing-schema.test.py"""
import copy
import json
from pathlib import Path
import subprocess
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
schema = json.loads((ROOT / 'docs/schemas/trialschema.v1.schema.json').read_text())
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema)
envelope = json.loads(subprocess.check_output(['node', 'tests/timing.test.mjs', '--fixture'], cwd=ROOT))
validator.validate(envelope)
legacy = copy.deepcopy(envelope)
legacy['format_version'] = '1.0'
for criterion in legacy['trials'][0]['criteria']:
    criterion.pop('timing', None)
validator.validate(legacy)

valid = [{'scope': 'current'}, {'scope': 'ever', 'description': 'in de voorgeschiedenis'}]
for unit, code in [('hours', 'h'), ('days', 'd'), ('weeks', 'wk'), ('months', 'mo'), ('years', 'a')]:
    valid.append({'scope': 'window', 'lookback': {'value': 1.5, 'unit': unit, 'code': code, 'system': 'http://unitsofmeasure.org'}})
invalid = [None, {}, {'scope': 'past'}, {'scope': 'window'}, {'scope': 'ever', 'lookback': {}},
           {'scope': 'current', 'lookback': None}, {'scope': 'ever', 'description': 1}, {'scope': 'ever', 'anchor': 'screening'}]
for value in [0, -1, '5']:
    invalid.append({'scope': 'window', 'lookback': {'value': value, 'unit': 'years', 'code': 'a'}})
for quantity in [{'value': 5}, {'value': 5, 'unit': 'years', 'code': 'd'},
                 {'value': 5, 'unit': 'years', 'code': 'a', 'system': 'unknown'},
                 {'value': 5, 'unit': 'years', 'code': 'a', 'extra': True}]:
    invalid.append({'scope': 'window', 'lookback': quantity})
for timing in valid:
    envelope['trials'][0]['criteria'][0]['timing'] = timing
    validator.validate(envelope)
for timing in invalid:
    envelope['trials'][0]['criteria'][0]['timing'] = timing
    assert list(validator.iter_errors(envelope)), f'Unexpectedly accepted {timing}'
print('Timing JSON Schema checks passed (including real app export and legacy v1.0).')
