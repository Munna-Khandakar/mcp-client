need to make a api call to `https://ideas.ideascale.me/a/rest/backend/v1/memberships`
reponse will be:
`[
    {
        "id": 27,
        "name": "Innovate with IdeaScale",
        "shortUrl": "ideas.ideascale.me/c/ideas",
        "key": "ideas",
        "privateCommunity": false,
        "admin": true,
        "logoUrl": "https://ideas.ideascale.me/a/img/ideascale-icon.png",
        "logoAltText": "Main Logo",
        "apiTokens": [
            "dabb57d4-dbcd-44da-a713-0d6496f94431"
        ]
    }
]`

from the 1st item in the array, we can get the `apiTokens` and it need to be used in the mcp client. so implement it in the TokenUtil class in  a new method