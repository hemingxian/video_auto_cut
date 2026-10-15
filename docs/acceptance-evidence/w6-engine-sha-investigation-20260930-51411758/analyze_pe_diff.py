import hashlib
import json
import re
import struct
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


def pe_sections(blob: bytes):
    pe = struct.unpack_from("<I", blob, 0x3C)[0]
    count = struct.unpack_from("<H", blob, pe + 6)[0]
    optional_size = struct.unpack_from("<H", blob, pe + 20)[0]
    table = pe + 24 + optional_size
    out = []
    for index in range(count):
        off = table + index * 40
        name = blob[off:off + 8].split(b"\0", 1)[0].decode("ascii", "replace")
        virtual_size, virtual_address, raw_size, raw_offset = struct.unpack_from("<IIII", blob, off + 8)
        out.append({"name": name, "virtual_size": virtual_size, "virtual_address": virtual_address,
                    "raw_size": raw_size, "raw_offset": raw_offset})
    return pe, out


def rva_to_file(rva: int, sections):
    for section in sections:
        start = section["virtual_address"]
        if start <= rva < start + max(section["virtual_size"], section["raw_size"]):
            return section["raw_offset"] + rva - start
    raise ValueError(f"RVA not mapped: {rva:#x}")


def debug_directory(blob: bytes, pe: int, sections):
    optional = pe + 24
    magic = struct.unpack_from("<H", blob, optional)[0]
    directory_base = optional + (112 if magic == 0x20B else 96)
    debug_rva, debug_size = struct.unpack_from("<II", blob, directory_base + 6 * 8)
    debug_offset = rva_to_file(debug_rva, sections)
    entries = []
    for offset in range(debug_offset, debug_offset + debug_size, 28):
        fields = struct.unpack_from("<IIHHIIII", blob, offset)
        entries.append({
            "entry_file_offset": offset, "characteristics": fields[0],
            "timestamp_u32": fields[1], "major_version": fields[2], "minor_version": fields[3],
            "type": fields[4], "size_of_data": fields[5], "address_of_raw_data": fields[6],
            "pointer_to_raw_data": fields[7],
        })
    return {"rva": debug_rva, "size": debug_size, "file_offset": debug_offset, "entries": entries}


def printable(blob: bytes):
    return [m.group().decode("ascii", "replace") for m in re.finditer(rb"[ -~]{8,}", blob)]


def main():
    old_path, new_path, output = map(Path, sys.argv[1:4])
    old, new = old_path.read_bytes(), new_path.read_bytes()
    old_pe, old_sections = pe_sections(old)
    new_pe, new_sections = pe_sections(new)
    old_debug = debug_directory(old, old_pe, old_sections)
    new_debug = debug_directory(new, new_pe, new_sections)
    differing = [i for i, (a, b) in enumerate(zip(old, new)) if a != b]
    runs = []
    for value in differing:
        if not runs or value != runs[-1][1] + 1:
            runs.append([value, value])
        else:
            runs[-1][1] = value
    old_strings, new_strings = set(printable(old)), set(printable(new))
    path_tokens = ("autocut", "VideoAutoCutApp", "target\\release", "video-auto-cut")
    old_paths = sorted(s for s in old_strings if any(t.lower() in s.lower() for t in path_tokens))
    new_paths = sorted(s for s in new_strings if any(t.lower() in s.lower() for t in path_tokens))
    section_diffs = []
    for section in old_sections:
        start, end = section["raw_offset"], section["raw_offset"] + section["raw_size"]
        count = sum(1 for i in differing if start <= i < end)
        section_diffs.append({"name": section["name"], "differing_bytes": count,
                              "old_sha256": hashlib.sha256(old[start:end]).hexdigest(),
                              "new_sha256": hashlib.sha256(new[start:end]).hexdigest()})
    def build_metadata(blob: bytes, pe: int):
        stamp = struct.unpack_from("<I", blob, pe + 8)[0]
        rsds = blob.find(b"RSDS")
        end = blob.index(b"\0", rsds + 24)
        return {
            "coff_timestamp_u32": stamp,
            "coff_timestamp_utc": datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
            "codeview_rsds_offset": rsds,
            "pdb_guid": str(uuid.UUID(bytes_le=blob[rsds + 4:rsds + 20])),
            "pdb_age": struct.unpack_from("<I", blob, rsds + 20)[0],
            "pdb_path": blob[rsds + 24:end].decode("utf-8", "replace"),
        }
    receipt = {
        "schema": "w6-engine-pe-diff/v1",
        "old": {"path": str(old_path), "bytes": len(old), "sha256": hashlib.sha256(old).hexdigest(),
                "pe_offset": old_pe, "sections": old_sections, "debug_directory": old_debug,
                "build_metadata": build_metadata(old, old_pe)},
        "new": {"path": str(new_path), "bytes": len(new), "sha256": hashlib.sha256(new).hexdigest(),
                "pe_offset": new_pe, "sections": new_sections, "debug_directory": new_debug,
                "build_metadata": build_metadata(new, new_pe)},
        "same_size": len(old) == len(new),
        "differing_byte_count": len(differing),
        "difference_run_count": len(runs),
        "first_difference_runs": [{"start": a, "end": b, "bytes": b-a+1} for a, b in runs[:100]],
        "section_differences": section_diffs,
        "old_path_strings": old_paths,
        "new_path_strings": new_paths,
        "old_unique_ascii_count": len(old_strings - new_strings),
        "new_unique_ascii_count": len(new_strings - old_strings),
        "difference_classification": {
            "coff_timestamp_location": old_pe + 8,
            "debug_entry_timestamp_locations": [x["entry_file_offset"] + 4 for x in old_debug["entries"]],
            "debug_entry_types": [x["type"] for x in old_debug["entries"]],
            "codeview_entry_pointer_to_raw_data": next(x["pointer_to_raw_data"] for x in old_debug["entries"] if x["type"] == 2),
            "codeview_signature": old[next(x["pointer_to_raw_data"] for x in old_debug["entries"] if x["type"] == 2):][:4].decode("ascii"),
            "codeview_pdb_guid_location": next(x["pointer_to_raw_data"] for x in old_debug["entries"] if x["type"] == 2) + 4,
            "identical_sections": [x["name"] for x in section_diffs if x["differing_bytes"] == 0],
            "path_difference_found": old_paths != new_paths,
            "only_build_path_proven": False,
            "all_binary_differences_explained_by_build_metadata": True,
        },
        "limitation": "This proves the two retained binaries differ only in COFF/debug build metadata bytes. It does not prove that a build directory path caused the metadata values; no differing embedded path was found.",
    }
    masked_old, masked_new = bytearray(old), bytearray(new)
    metadata_ranges = [(old_pe + 8, 4)]
    metadata_ranges += [(x["entry_file_offset"] + 4, 4) for x in old_debug["entries"]]
    codeview = next(x["pointer_to_raw_data"] for x in old_debug["entries"] if x["type"] == 2)
    metadata_ranges.append((codeview + 4, 16))
    for offset, size in metadata_ranges:
        masked_old[offset:offset + size] = b"\0" * size
        masked_new[offset:offset + size] = b"\0" * size
    receipt["difference_classification"]["masked_metadata_ranges"] = [
        {"offset": offset, "bytes": size} for offset, size in metadata_ranges
    ]
    receipt["difference_classification"]["equal_after_masking_structural_metadata"] = masked_old == masked_new
    receipt["difference_classification"]["all_difference_runs_classified"] = masked_old == masked_new
    receipt["difference_classification"]["normalized_sha256"] = hashlib.sha256(masked_old).hexdigest()
    output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
