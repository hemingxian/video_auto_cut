# History plan-only fixture

Derived from the frozen `job_plan.json`, `checkpoint.json`, and `shots.json` captured for issue IKK0H4 note 51530332.

The checkpoint signature was replaced because the original contains private configuration and absolute paths. Shot text, task identity, and media paths were also replaced with public test values. The shots fixture retains the real nine-shot count and revision 11 while reducing each shot to the minimum fields needed to preserve saved material-binding semantics. The plan step structure, completed checkpoint steps, absence of generation steps, absence of `incremental.json`, and saved-shot semantics are preserved.
