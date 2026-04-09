import argparse
import json
from pathlib import Path

import joblib
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, f1_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline


def parse_args():
    parser = argparse.ArgumentParser(description="Train local text classifier (description -> class)")
    parser.add_argument("--data", required=True, help="Path to training CSV")
    parser.add_argument(
        "--class-file",
        default="../Class.csv",
        help="Path to class catalog CSV (defaults to ../Class.csv)",
    )
    parser.add_argument(
        "--class-column",
        default="Classification",
        help="Column name for class catalog values",
    )
    parser.add_argument("--text-column", default="description", help="Column name for text")
    parser.add_argument("--label-column", default="class", help="Column name for label")
    parser.add_argument("--output-dir", default="model", help="Directory to save trained model")
    parser.add_argument("--test-size", type=float, default=0.2, help="Validation split ratio")
    return parser.parse_args()


def clean_text(value):
    if value is None:
        return ""
    return str(value).strip()


def read_csv_with_fallback(path: Path):
    frame = None
    read_errors = []
    for encoding in ["utf-8", "utf-8-sig", "cp1252", "latin-1"]:
        try:
            frame = pd.read_csv(path, encoding=encoding)
            break
        except UnicodeDecodeError as ex:
            read_errors.append(f"{encoding}: {ex}")

    if frame is None:
        raise ValueError(
            "Unable to read CSV with supported encodings. Tried utf-8, utf-8-sig, cp1252, latin-1. "
            + " | ".join(read_errors)
        )

    return frame


def load_class_catalog(class_file: str, class_column: str):
    class_path = Path(class_file)
    if not class_path.exists():
        raise FileNotFoundError(f"Class catalog file not found: {class_path}")

    class_df = read_csv_with_fallback(class_path)

    column_name = class_column
    if column_name not in class_df.columns:
        if len(class_df.columns) == 1:
            column_name = class_df.columns[0]
        elif "class" in class_df.columns:
            column_name = "class"
        elif "Classification" in class_df.columns:
            column_name = "Classification"
        else:
            raise ValueError(
                f"Missing class catalog column: {class_column}. Available columns: {list(class_df.columns)}"
            )

    values = class_df[column_name].map(clean_text)
    values = [item for item in values.tolist() if item != ""]
    unique_values = sorted(set(values))

    return {
        "source": str(class_path),
        "column": column_name,
        "available_classes": unique_values,
        "loaded": True,
    }


def main():
    args = parse_args()
    data_path = Path(args.data)
    if not data_path.exists():
        raise FileNotFoundError(f"Training file not found: {data_path}")

    df = read_csv_with_fallback(data_path)
    if args.text_column not in df.columns:
        raise ValueError(f"Missing text column: {args.text_column}")
    if args.label_column not in df.columns:
        raise ValueError(f"Missing label column: {args.label_column}")

    work_df = df[[args.text_column, args.label_column]].copy()
    work_df[args.text_column] = work_df[args.text_column].map(clean_text)
    work_df[args.label_column] = work_df[args.label_column].map(clean_text)
    work_df = work_df[(work_df[args.text_column] != "") & (work_df[args.label_column] != "")]

    if work_df.empty:
        raise ValueError("No usable rows found after cleaning.")

    x = work_df[args.text_column]
    y = work_df[args.label_column]

    pipeline = Pipeline(
        steps=[
            (
                "tfidf",
                TfidfVectorizer(
                    lowercase=True,
                    strip_accents="unicode",
                    ngram_range=(1, 2),
                    min_df=1,
                    max_features=50000,
                ),
            ),
            (
                "clf",
                LogisticRegression(
                    max_iter=2000,
                    solver="lbfgs",
                ),
            ),
        ]
    )

    use_split = len(work_df) >= 20 and y.nunique() > 1
    metrics = {}

    if use_split:
        try:
            x_train, x_test, y_train, y_test = train_test_split(
                x,
                y,
                test_size=args.test_size,
                random_state=42,
                stratify=y if y.nunique() > 1 else None,
            )
        except ValueError:
            x_train, x_test, y_train, y_test = train_test_split(
                x,
                y,
                test_size=args.test_size,
                random_state=42,
                stratify=None,
            )
        pipeline.fit(x_train, y_train)
        y_pred = pipeline.predict(x_test)

        metrics = {
            "accuracy": float(accuracy_score(y_test, y_pred)),
            "f1_macro": float(f1_score(y_test, y_pred, average="macro", zero_division=0)),
            "samples": int(len(work_df)),
            "classes": int(y.nunique()),
        }
        report = classification_report(y_test, y_pred, zero_division=0)
    else:
        pipeline.fit(x, y)
        metrics = {
            "accuracy": None,
            "f1_macro": None,
            "samples": int(len(work_df)),
            "classes": int(y.nunique()),
        }
        report = "Not enough data for a reliable validation split (trained on full dataset)."

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    model_path = output_dir / "model.joblib"
    metadata_path = output_dir / "metadata.json"

    joblib.dump(pipeline, model_path)

    class_catalog = load_class_catalog(args.class_file, args.class_column)

    training_classes = sorted(y.unique().tolist())
    catalog_classes = class_catalog["available_classes"]
    catalog_set = set(catalog_classes)
    training_set = set(training_classes)

    metadata = {
        "text_column": args.text_column,
        "label_column": args.label_column,
        "metrics": metrics,
        "unique_classes": training_classes,
        "class_catalog": {
            "source": class_catalog["source"],
            "column": class_catalog["column"],
            "loaded": class_catalog["loaded"],
            "count": len(catalog_classes),
            "available_classes": catalog_classes,
            "missing_in_training": sorted(catalog_set - training_set),
            "extra_in_training": sorted(training_set - catalog_set),
        },
    }
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print(f"Saved model: {model_path}")
    print(f"Saved metadata: {metadata_path}")
    print("Metrics:", json.dumps(metrics, indent=2))
    print("Report:")
    print(report)


if __name__ == "__main__":
    main()
