import psycopg2
from flask import current_app
from psycopg2.extras import DictCursor, execute_values
from psycopg2.sql import SQL, Identifier
from sqlalchemy import text

from listenbrainz.db import color
from listenbrainz.db.recording import load_recordings_from_mbids_with_redirects
from listenbrainz.spark.spark_dataset import DatabaseDataset
from listenbrainz.webserver.views.metadata_api import fetch_release_group_metadata


class PopularityDataset(DatabaseDataset):
    """ Dataset class for artists, recordings and releases with popularity info (listen count and unique listener count)
     from MLHD data """

    def __init__(self, entity):
        super().__init__(f"mlhd_popularity_{entity}", entity, "popularity")
        self.entity = entity
        self.entity_mbid = f"{entity}_mbid"

    def get_table(self):
        return f"""
            CREATE TABLE {{table}} (
                {self.entity_mbid}      UUID NOT NULL,
                total_listen_count      INTEGER NOT NULL,
                total_user_count        INTEGER NOT NULL
            )
        """

    def get_inserts(self, message):
        query = f"INSERT INTO {{table}} ({self.entity_mbid}, total_listen_count, total_user_count) VALUES %s"
        values = [(r[self.entity_mbid], r["total_listen_count"], r["total_user_count"]) for r in message["data"]]
        return query, None, values

    def get_indexes(self):
        return [
            f"CREATE INDEX popularity_{self.entity}_listen_count_idx_{{suffix}} ON {{table}} (total_listen_count) INCLUDE ({self.entity_mbid})",
            f"CREATE INDEX popularity_{self.entity}_user_count_idx_{{suffix}} ON {{table}} (total_user_count) INCLUDE ({self.entity_mbid})"
        ]


class PopularityTopDataset(DatabaseDataset):
    """ Dataset class for all recordings and releases with popularity info (total listen count and unique listener
     count) for each artist in MLHD data. """

    def __init__(self, entity):
        super().__init__(f"mlhd_popularity_top_{entity}", f"top_{entity}", "popularity")
        self.entity = entity
        self.entity_mbid = f"{entity}_mbid"

    def get_table(self):
        return f"""
            CREATE TABLE {{table}} (
                artist_mbid             UUID NOT NULL,
                {self.entity_mbid}      UUID NOT NULL,
                total_listen_count      INTEGER NOT NULL,
                total_user_count        INTEGER NOT NULL
            )
        """

    def get_inserts(self, message):
        query = f"INSERT INTO {{table}} (artist_mbid, {self.entity_mbid}, total_listen_count, total_user_count) VALUES %s"
        values = [(r["artist_mbid"], r[self.entity_mbid], r["total_listen_count"], r["total_user_count"]) for r in message["data"]]
        return query, None, values

    def get_indexes(self):
        return [
            f"CREATE INDEX popularity_top_{self.entity}_artist_mbid_listen_count_idx_{{suffix}} ON {{table}} (artist_mbid, total_listen_count) INCLUDE ({self.entity_mbid})",
            f"CREATE INDEX popularity_top_{self.entity}_artist_mbid_user_count_idx_{{suffix}} ON {{table}} (artist_mbid, total_user_count) INCLUDE ({self.entity_mbid})"
        ]


RecordingPopularityDataset = PopularityDataset("recording")
ArtistPopularityDataset = PopularityDataset("artist")
ReleasePopularityDataset = PopularityDataset("release")
ReleaseGroupPopularityDataset = PopularityDataset("release_group")
TopRecordingPopularityDataset = PopularityTopDataset("recording")
TopReleasePopularityDataset = PopularityTopDataset("release")
TopReleaseGroupPopularityDataset = PopularityTopDataset("release_group")


def get_top_entity_for_artist(ts_conn, entity, artist_mbid, count=None):
    """ Get the top 'count' recordings, releases or release-groups for a given artist mbid

        By default running all recordings (entities) of the artist returned.
    """
    if entity == "recording":
        entity_mbid = "recording_mbid"
    elif entity == "release_group":
        entity_mbid = "release_group_mbid"
    elif entity == "release":
        entity_mbid = "release_mbid"
    else:
        return []

    if count is None:
        limit = ""
    else:
        limit = "LIMIT :count"

    query = """
        SELECT """ + entity_mbid + """::TEXT
             , total_listen_count
             , total_user_count
          FROM popularity.top_""" + entity + """
         WHERE artist_mbid = :artist_mbid
      ORDER BY total_listen_count DESC
    """ + limit
    results = ts_conn.execute(text(query), {"artist_mbid": artist_mbid, "count": count})
    return results.mappings().all()


def get_counts(ts_conn, entity, mbids):
    """ Get the total listen and user counts for a given entity and list of mbids """
    if entity == "recording":
        entity_mbid = "recording_mbid"
    elif entity == "release_group":
        entity_mbid = "release_group_mbid"
    elif entity == "release":
        entity_mbid = "release_mbid"
    else:
        return []

    query = SQL("""
          WITH mbids (mbid) AS (VALUES %s)
        SELECT mbid
             , total_listen_count
             , total_user_count
          FROM {table}
          JOIN mbids
            ON {entity_mbid} = mbid::UUID
    """).format(entity_mbid=Identifier(entity_mbid), table=Identifier("popularity", entity))
    ts_curs = ts_conn.connection.cursor()
    results = execute_values(ts_curs, query, [(mbid, ) for mbid in mbids], fetch=True)
    index = {row[0]: (row[1], row[2]) for row in results}

    entity_data = []
    for mbid in mbids:
        total_listen_count, total_user_count = index.get(mbid, (None, None))
        entity_data.append({entity_mbid: mbid, "total_listen_count": total_listen_count, "total_user_count": total_user_count})
    return entity_data, index


def get_top_recordings_for_artist(db_conn, ts_conn, artist_mbid, count=None):
    """ Get the top recordings for a given artist mbid """
    recordings = get_top_entity_for_artist(ts_conn, "recording", artist_mbid, count)
    recording_mbids = [str(r["recording_mbid"]) for r in recordings]
    with psycopg2.connect(current_app.config["MB_DATABASE_URI"]) as mb_conn, \
            mb_conn.cursor(cursor_factory=DictCursor) as mb_curs, \
            ts_conn.connection.cursor(cursor_factory=DictCursor) as ts_curs:
        recordings_data = load_recordings_from_mbids_with_redirects(mb_curs, ts_curs, recording_mbids)
        release_mbids = [str(r["release_mbid"]) for r in recordings_data if r["release_mbid"] is not None]
        releases_color = color.fetch_color_for_releases(db_conn, release_mbids)

        results = []
        for recording, data in zip(recordings, recordings_data):
            if data["artist_credit_name"] is None:
                continue

            data.pop("artist_credit_id", None)
            data.pop("canonical_recording_mbid", None)
            data.pop("original_recording_mbid", None)
            data.update({
                "artist_name": data.pop("artist_credit_name"),
                "artist_mbids": data.pop("[artist_credit_mbids]"),
                "total_listen_count": recording["total_listen_count"],
                "total_user_count": recording["total_user_count"],
                "release_color": releases_color.get(str(data["release_mbid"]), {})
            })
            results.append(data)

        return results


def get_top_release_groups_for_artist(db_conn, ts_conn, artist_mbid: str, count=None):
    """ Get the top releases for a given artist mbid """
    release_groups = get_top_entity_for_artist(ts_conn, "release_group", artist_mbid, count)
    release_group_mbids = [str(r["release_group_mbid"]) for r in release_groups]

    release_groups_data = []
    for i in range(0, len(release_group_mbids), 50):
        fetched_data = fetch_release_group_metadata(release_group_mbids[i:i + 50], incs=["artist", "release", "tag"])

        release_group_data_list = []
        for release_group_mbid, release_group_data in fetched_data.items():
            release_group_data["release_group_mbid"] = release_group_mbid
            release_group_data_list.append(release_group_data)

        release_groups_data.extend(release_group_data_list)

    release_groups_data.sort(key=lambda x: release_group_mbids.index(x["release_group_mbid"]))

    release_mbids = [
        str(r["release"]['caa_release_mbid']) for r in release_groups_data
        if r["release"] is not None and r["release"]['caa_release_mbid'] is not None
    ]

    releases_color = color.fetch_color_for_releases(db_conn, release_mbids)

    for release_group, pop in zip(release_groups_data, release_groups):
        release_group.update({
            "total_listen_count":
            pop["total_listen_count"],
            "total_user_count":
            pop["total_user_count"],
            "release_color":
            releases_color.get(str(release_group["release"]["caa_release_mbid"] if release_group["release"] is not None else None),
                               {})
        })

    return release_groups_data
