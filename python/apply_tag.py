import os
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

token = os.getenv("READWISE_TOKEN")
if not token:
    raise RuntimeError("READWISE_TOKEN is required in .env or the environment")


def get_docs():
    querystring = {
        "category": "rss",
        "location": "feed",
    }

    response = requests.get(
        url="https://readwise.io/api/v3/list/",
        headers={"Authorization": f"Token {token}"},
        params=querystring
    )

    return response.json()

    

def apply_tag(doc_id:str, tag:str):
    response = requests.patch(
        url=f"https://readwise.io/api/v3/update/{doc_id}",
        headers={"Authorization": f"Token {token}"},
        json={"tags": [tag]}
    )
    return response.json()



# print(get_docs())

apply_tag("01kk43xs84w1r565s44y28knpy", "API_TEST")
