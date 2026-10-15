# ASS text audit summary (51404601)

Source receipt SHA256: `5139507b0793e297a46baa9ffa8188fa290994151dfba0c83e0d707bc55f885b`

| Shot | Events / groups | Clip s / last ASS end | Allowed removed event tails | Result |
|---:|---:|---:|---|---|
| 1 | 4 / 4 | 8.000 / 7.36 | e1@8:，; e2@18:，; e3@30:，; e4@35:。 | PASS |
| 2 | 1 / 1 | 9.000 / 8.54 | e1@13:。 | PASS |
| 3 | 6 / 6 | 11.000 / 9.68 | e1@12:，; e2@18:，; e3@25:。; e4@29:、; e5@33:，; e6@42:。 | PASS |
| 4 | 5 / 5 | 8.000 / 7.44 | e1@5:，; e2@15:，; e3@25:，; e4@30:，; e5@36:。 | PASS |
| 5 | 5 / 5 | 8.000 / 7.28 | e1@6:，; e2@11:。; e3@18:、; e4@23:，; e5@33:。 | PASS |
| 6 | 5 / 5 | 10.000 / 9.28 | e1@6:，; e2@11:，; e3@21:，; e4@29:，; e5@36:。 | PASS |
| 7 | 4 / 4 | 8.000 / 6.80 | e1@8:、; e2@15:，; e3@27:，; e4@33:。 | PASS |
| 8 | 2 / 1 | 10.000 / 9.50 | e2@29:。 | PASS |
| 9 | 3 / 3 | 8.000 / 6.64 | e1@11:，; e2@20:，; e3@34:。 | PASS |

Total events: 35; allowed removed tails: 34; time tolerance: 0 seconds.

Only shot 8 has a same-time physical multiline group: 0.00–9.50, y=993/1075. Other shots use temporal event segmentation.

This local ASS result does not decide whether the final duration difference from the issue reference is acceptable.
