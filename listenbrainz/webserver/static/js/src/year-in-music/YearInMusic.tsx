import * as ReactDOM from "react-dom";
import * as React from "react";
import { ResponsiveBar } from "@nivo/bar";
import Coverflow from "react-coverflow";
import { CalendarDatum, ResponsiveCalendar } from "@nivo/calendar";
import {
  get,
  isEmpty,
  isNil,
  isString,
  range,
  uniq,
  capitalize,
  toPairs,
} from "lodash";
import ErrorBoundary from "../ErrorBoundary";
import GlobalAppContext, { GlobalAppContextT } from "../GlobalAppContext";
import BrainzPlayer from "../BrainzPlayer";

import {
  WithAlertNotificationsInjectedProps,
  withAlertNotifications,
} from "../AlertNotificationsHOC";

import APIServiceClass from "../APIService";
import { getPageProps } from "../utils";
import { getEntityLink } from "../stats/utils";
import ComponentToImage from "./ComponentToImage";

import fakeData from "./year-in-music-data.json";
import ListenCard from "../listens/ListenCard";
import UserListModalEntry from "../follow/UserListModalEntry";
import { JSPFTrackToListen } from "../playlists/utils";

export type YearInMusicProps = {
  user: ListenBrainzUser;
  yearInMusicData: {
    day_of_week: string;
    top_artists: Array<{
      artist_name: string;
      artist_mbids: string[];
      listen_count: number;
    }>;
    top_releases: Array<{
      artist_name: string;
      artist_mbids: string[];
      listen_count: number;
      release_name: string;
      release_mbid: string;
    }>;
    top_recordings: Array<{
      artist_name: string;
      artist_mbids: string[];
      listen_count: number;
      release_name: string;
      release_mbid: string;
      track_name: string;
      recording_mbid: string;
    }>;
    similar_users: { [key: string]: number };
    listens_per_day: Array<{
      to_ts: number;
      from_ts: number;
      time_range: string;
      listen_count: number;
    }>;
    most_listened_year: { [key: string]: number };
    total_listen_count: number;
    most_prominent_color: string;
    new_releases_of_top_artists: Array<{
      type: string;
      title: string;
      release_id: string;
      first_release_date: string;
      artist_credit_mbids: string[];
      artist_credit_names: string[];
    }>;
  };
} & WithAlertNotificationsInjectedProps;

export type YearInMusicState = {
  followingList: Array<string>;
  listens: Array<Listen>;
};

export default class YearInMusic extends React.Component<
  YearInMusicProps,
  YearInMusicState
> {
  static contextType = GlobalAppContext;
  declare context: React.ContextType<typeof GlobalAppContext>;

  constructor(props: YearInMusicProps) {
    super(props);
    this.state = {
      followingList: [],
      listens: [],
    };
  }

  async componentDidMount() {
    await this.getFollowing();
  }

  private getPlaylistByName(
    playlistName: string,
    description?: string
  ): { jspf: JSPFObject; mbid: string; description?: string } | undefined {
    const { yearInMusicData } = this.props;
    let playlist;
    try {
      const rawPlaylist = get(yearInMusicData, playlistName);
      playlist = isString(rawPlaylist) ? JSON.parse(rawPlaylist) : rawPlaylist;
      // Append manual description used in this page (rather than parsing HTML, ellipsis issues, etc.)
      if (description) {
        playlist.description = description;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`"Error parsing ${playlistName}:`, error);
    }
    return playlist;
  }

  getFollowing = async () => {
    const { APIService, currentUser } = this.context;
    const { getFollowingForUser } = APIService;
    if (!currentUser?.name) {
      return;
    }
    try {
      const response = await getFollowingForUser(currentUser.name);
      const { following } = response;

      this.setState({ followingList: following });
    } catch (err) {
      const { newAlert } = this.props;
      newAlert("danger", "Error while fetching followers", err.toString());
    }
  };

  updateFollowingList = (
    user: ListenBrainzUser,
    action: "follow" | "unfollow"
  ) => {
    const { followingList } = this.state;
    const newFollowingList = [...followingList];
    const index = newFollowingList.findIndex(
      (following) => following === user.name
    );
    if (action === "follow" && index === -1) {
      newFollowingList.push(user.name);
    }
    if (action === "unfollow" && index !== -1) {
      newFollowingList.splice(index, 1);
    }
    this.setState({ followingList: newFollowingList });
  };

  loggedInUserFollowsUser = (user: ListenBrainzUser): boolean => {
    const { currentUser } = this.context;
    const { followingList } = this.state;

    if (isNil(currentUser) || isEmpty(currentUser)) {
      return false;
    }

    return followingList.includes(user.name);
  };

  render() {
    const { user, newAlert, yearInMusicData } = this.props;
    const { APIService, currentUser } = this.context;
    const { listens } = this.state;

    if (!yearInMusicData || isEmpty(yearInMusicData)) {
      return (
        <div className="flex-center flex-wrap">
          <h3>
            We don&apos;t have enough listening data for {user.name} to produce
            any statistics or playlists.
          </h3>
          <p>
            Check out how you can submit listens by{" "}
            <a href="/profile/music-services/details/">
              connecting a music service
            </a>{" "}
            or <a href="/profile/import/">importing your listening history</a>,
            and come back next year !
          </p>
        </div>
      );
    }

    // Is the logged-in user looking at their own page?
    const isCurrentUser = user.name === currentUser?.name;
    const youOrUsername = isCurrentUser ? "you" : `${user.name}`;
    const yourOrUsersName = isCurrentUser ? "your" : `${user.name}'s`;

    /* Most listened years */
    let mostListenedYearDataForGraph;
    if (!isEmpty(yearInMusicData.most_listened_year)) {
      const mostListenedYears = Object.keys(yearInMusicData.most_listened_year);
      // Ensure there are no holes between years
      const filledYears = range(
        Number(mostListenedYears[0]),
        Number(mostListenedYears[mostListenedYears.length - 1])
      );
      mostListenedYearDataForGraph = filledYears.map((year: number) => ({
        year,
        // Set to 0 for years without data
        albums: String(yearInMusicData.most_listened_year[String(year)] ?? 0),
      }));
    }

    /* Similar users sorted by similarity score */
    const sortedSimilarUsers = toPairs(yearInMusicData.similar_users).sort(
      (a, b) => b[1] - a[1]
    );

    /* Listening history calendar graph */
    const listensPerDayForGraph = yearInMusicData.listens_per_day
      .map((datum) =>
        datum.listen_count > 0
          ? {
              day: new Date(datum.time_range).toLocaleDateString("en-CA"),
              value: datum.listen_count,
            }
          : // Return null if the value is 0
            null
      )
      // Filter out null entries in the array
      .filter(Boolean);

    /* Playlists */
    const topDiscoveriesPlaylist = this.getPlaylistByName(
      "playlist-top-discoveries-for-year-playlists",
      `Highlights songs that ${user.name} first listened to (more than once) in 2021`
    );
    const topMissedRecordingsPlaylist = this.getPlaylistByName(
      "playlist-top-missed-recordings-for-year-playlists",
      `Favorite songs of ${user.name}'s most similar users that ${user.name} hasn't listened to this year`
    );
    const topNewRecordingsPlaylist = this.getPlaylistByName(
      "playlist-top-new-recordings-for-year-playlists",
      `Songs released in 2021 that ${user.name} listened to`
    );
    const topRecordingsPlaylist = this.getPlaylistByName(
      "playlist-top-recordings-for-year-playlists",
      `This playlist is made from ${user.name}'s top recordings for 2021 statistics`
    );

    const allPlaylists = [
      topDiscoveriesPlaylist,
      topMissedRecordingsPlaylist,
      topNewRecordingsPlaylist,
      topRecordingsPlaylist,
    ];

    return (
      <div role="main" id="year-in-music">
        <div className="flex flex-wrap" id="header">
          <div className="content-card flex-center flex-wrap">
            <img
              className="img-responsive header-image"
              src="/static/img/year-in-music-2021.svg"
              alt="Your year in music 2021"
            />
            <div>
              <h4>
                <div className="center-p">
                  Share your year with your friends
                  <p id="share-link">
                    <a
                      href={`https://listenbrainz.org/user/${user.name}/year-in-music/`}
                    >
                      https://listenbrainz.org/user/{user.name}/year-in-music/
                    </a>
                  </p>
                </div>
              </h4>
            </div>
          </div>
          <div>
            <h1>{user.name}</h1>
            <p>
              See profile on&nbsp;
              <img src="/static/img/favicon-16.png" alt="ListenBrainz Logo" />
              <a href={`https://listenbrainz.org/user/${user.name}/`}>
                ListenBrainz
              </a>
              &nbsp;and&nbsp;
              <img
                src="/static/img/musicbrainz-16.svg"
                alt="MusicBrainz Logo"
              />
              <a href={`https://musicbrainz.org/user/${user.name}`}>
                MusicBrainz
              </a>
            </p>
            <p>
              The ListenBrainz team would like to wish you happy holidays! You
              have been sending us your listen history in 2021 and we wanted to
              thank you for doing that! We have been working hard to create
              useful personalized features based on your data. We hope you like
              it!
            </p>
            <p>You will find in this page:</p>
            <ul>
              <li>
                {yourOrUsersName} top <a href="#top-releases">albums</a>,{" "}
                <a href="#top-recordings">songs</a> and{" "}
                <a href="#top-artists">artists</a> of the year
              </li>
              <li>
                some statistics about your{" "}
                <a href="#calendar">listening activity</a>
              </li>
              <li>
                a list of{" "}
                <a href="#similar-users">users similar to {youOrUsername}</a>
              </li>
              <li>
                new albums that your top artists{" "}
                <a href="#new-releases">released in 2021</a>
              </li>
              <li>
                and finally four <a href="#playlists">personalized playlists</a>
                of music {youOrUsername} listened to and new songs to discover
              </li>
            </ul>
            <p>
              Double click on any song to start playing it — we will do our best
              to find a matching song to play. If you have a Spotify pro
              account, we recommend{" "}
              <a href="/profile/music-services/details/">
                connecting your account
              </a>{" "}
              for a better playback experience.
            </p>
            <p>
              We hope you like it! With love, the{" "}
              <a href="https://metabrainz.org/team">MetaBrainz team</a>
            </p>
          </div>
        </div>
        <hr className="wide" />
        <div className="row">
          <div className="card content-card" id="top-releases">
            <div className="col-md-12 d-flex center-p">
              <h3>{capitalize(yourOrUsersName)} top albums of 2021</h3>
              <ComponentToImage
                data={yearInMusicData.top_releases.slice(0, 10)}
                entityType="release"
                user={user}
              />
            </div>
            <div>
              <Coverflow
                displayQuantityOfSide={3}
                currentFigureScale={2}
                otherFigureScale={1}
                navigation
                enableScroll
                infiniteScroll
                enableHeading
                active={0}
                media={{
                  "@media (max-width: 900px)": {
                    width: "100%",
                    height: "300px",
                  },
                  "@media (min-width: 900px)": {
                    width: "100%",
                    height: "500px",
                  },
                }}
              >
                {yearInMusicData.top_releases.slice(0, 50).map((release) => (
                  <img
                    src="/static/img/cover-art-placeholder.jpg"
                    alt={release.release_name}
                  />
                ))}
              </Coverflow>
            </div>
          </div>
        </div>
        <div className="row flex flex-wrap">
          <div className="card content-card" id="top-recordings">
            <div className="col-md-12 d-flex center-p">
              <h3>
                {capitalize(yourOrUsersName)} 50 most played songs of 2021
              </h3>
              <ComponentToImage
                data={yearInMusicData.top_recordings.slice(0, 10)}
                entityType="recording"
                user={user}
              />
            </div>
            <div className="scrollable-area">
              {yearInMusicData.top_recordings.slice(0, 50).map((recording) => {
                const listenHere = {
                  listened_at: 0,
                  track_metadata: {
                    artist_name: recording.artist_name,
                    track_name: recording.track_name,
                    release_name: recording.release_name,
                    additional_info: {
                      recording_mbid: recording.recording_mbid,
                      release_mbid: recording.release_mbid,
                      artist_mbids: recording.artist_mbids,
                    },
                  },
                };
                listens.push(listenHere);
                return (
                  <ListenCard
                    compact
                    key={`top-recordings-${recording.recording_mbid}`}
                    listen={listenHere}
                    showTimestamp={false}
                    showUsername={false}
                    newAlert={newAlert}
                  />
                );
              })}
            </div>
          </div>
          <div className="card content-card" id="top-artists">
            <div className="col-md-12 d-flex center-p">
              <h3>{capitalize(yourOrUsersName)} top 50 artists of 2021</h3>
              <ComponentToImage
                data={yearInMusicData.top_artists.slice(0, 10)}
                entityType="artist"
                user={user}
              />
            </div>
            <div className="scrollable-area">
              {yearInMusicData.top_artists.slice(0, 50).map((artist) => {
                const details = getEntityLink(
                  "artist",
                  artist.artist_name,
                  artist.artist_mbids[0]
                );
                const thumbnail = (
                  <span className="badge badge-info">
                    {artist.listen_count} listens
                  </span>
                );
                const listenHere = {
                  listened_at: 0,
                  track_metadata: {
                    track_name: "",
                    artist_name: artist.artist_name,
                    additional_info: {
                      artist_mbids: artist.artist_mbids,
                    },
                  },
                };
                listens.push(listenHere);
                return (
                  <ListenCard
                    compact
                    key={`top-artists-${artist.artist_name}-${artist.artist_mbids}`}
                    listen={listenHere}
                    thumbnail={thumbnail}
                    listenDetails={details}
                    showTimestamp={false}
                    showUsername={false}
                    newAlert={newAlert}
                  />
                );
              })}
            </div>
          </div>
        </div>
        <div className="row">
          <div className="card content-card" id="calendar">
            <h3 className="text-center">
              {capitalize(yourOrUsersName)} listening activity in 2021
              <div className="small mt-15">
                Number of listens submitted for each day of the year
              </div>
            </h3>
            <div className="graph">
              <ResponsiveCalendar
                from="2021-01-01"
                to="2021-12-31"
                data={listensPerDayForGraph as CalendarDatum[]}
                emptyColor="#eeeeee"
                colors={["#bbb7e1", "#6e66cc", "#eea582", "#eb743b"]}
                monthBorderColor="#eeeeee"
                dayBorderWidth={2}
                dayBorderColor="#ffffff"
                legends={[
                  {
                    anchor: "bottom-right",
                    direction: "row",
                    itemCount: 4,
                    itemWidth: 42,
                    itemHeight: 36,
                    itemsSpacing: 14,
                    itemDirection: "right-to-left",
                  },
                ]}
              />
            </div>
          </div>
        </div>
        <div className="row flex flex-wrap">
          <div className="card content-card">
            <h3 className="text-center">
              {capitalize(youOrUsername)} listened to{" "}
              <span className="accent">
                {yearInMusicData.total_listen_count}
              </span>{" "}
              songs this year
            </h3>
          </div>
          <div className="card content-card">
            <h3 className="text-center">
              <span className="accent">Friday</span> was {yourOrUsersName} most
              active listening day
            </h3>
          </div>
        </div>
        <div className="row flex flex-wrap">
          {mostListenedYearDataForGraph && (
            <div className="card content-card" id="most-listened-year">
              <h3 className="text-center">
                What year are {yourOrUsersName} favorite albums from?
                <div className="small mt-15">
                  How much were you on the lookout for new music this year? Not
                  that we&apos;re judging.
                </div>
              </h3>
              <div className="graph">
                <ResponsiveBar
                  margin={{ left: 30, bottom: 30 }}
                  data={mostListenedYearDataForGraph}
                  padding={0.1}
                  layout="vertical"
                  keys={["albums"]}
                  indexBy="year"
                  colors="#eb743b"
                  enableLabel={false}
                  axisBottom={{
                    // Round to nearest 5 year mark
                    tickValues: uniq(
                      mostListenedYearDataForGraph.map(
                        (datum) => Math.round((datum.year + 1) / 5) * 5
                      )
                    ),
                  }}
                />
              </div>
            </div>
          )}
        </div>
        <div className="row flex flex-wrap">
          <div className="card content-card" id="similar-users">
            <h3 className="text-center">
              Music buddies
              <div className="small mt-15">
                Here are the users with the most similar taste to {user.name}{" "}
                this year. Maybe go check them out?
              </div>
            </h3>
            <div className="scrollable-area similar-users-list">
              {sortedSimilarUsers?.length &&
                sortedSimilarUsers.map((userFromList) => {
                  const [name, similarityScore] = userFromList;
                  const similarUser: SimilarUser = {
                    name,
                    similarityScore,
                  };
                  const loggedInUserFollowsUser = this.loggedInUserFollowsUser(
                    similarUser
                  );
                  return (
                    <UserListModalEntry
                      mode="similar-users"
                      key={name}
                      user={similarUser}
                      loggedInUserFollowsUser={loggedInUserFollowsUser}
                      updateFollowingList={this.updateFollowingList}
                    />
                  );
                })}
            </div>
          </div>

          <div className="card content-card" id="new-releases">
            <h3 className="text-center">
              New albums of {yourOrUsersName} top artists
              <div className="small mt-15">
                New albums released in 2021 from {yourOrUsersName} favorite
                artists
              </div>
            </h3>
            <div className="scrollable-area">
              {yearInMusicData.new_releases_of_top_artists.map((release) => {
                const artistName = release.artist_credit_names.join(", ");
                const details = (
                  <>
                    <div title={release.title} className="ellipsis-2-lines">
                      {getEntityLink(
                        "release",
                        release.title,
                        release.release_id
                      )}
                    </div>
                    <span
                      className="small text-muted ellipsis"
                      title={artistName}
                    >
                      {getEntityLink(
                        "artist",
                        artistName,
                        release.artist_credit_mbids[0]
                      )}
                    </span>
                  </>
                );
                const listenHere = {
                  listened_at: 0,
                  listened_at_iso: release.first_release_date,
                  track_metadata: {
                    artist_name: artistName,
                    track_name: release.title,
                    release_name: release.title,
                    additional_info: {
                      release_mbid: release.release_id,
                      artist_mbids: release.artist_credit_mbids,
                    },
                  },
                };
                listens.push(listenHere);
                return (
                  <ListenCard
                    listenDetails={details}
                    key={release.release_id}
                    compact
                    listen={listenHere}
                    showTimestamp={false}
                    showUsername={false}
                    newAlert={newAlert}
                  />
                );
              })}
            </div>
          </div>
        </div>
        <div className="row">
          <div className="card content-card" id="playlists">
            <h3 className="text-center">
              We made some personalized playlists for {youOrUsername} !
              <div className="small mt-15">
                You&apos;ll find below 3 playlists that encapsulate your year,
                and 1 playlist of music exploration based on users similar to
                you
              </div>
            </h3>
            <div className="row flex flex-wrap">
              {allPlaylists.map((topLevelPlaylist) => {
                if (!topLevelPlaylist) {
                  return undefined;
                }
                return (
                  <div className="card content-card mb-10" id="top-discoveries">
                    <h3 className="text-center">
                      <a
                        href={`/playlist/${topLevelPlaylist.mbid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {topLevelPlaylist.jspf?.playlist?.title}
                      </a>
                      {topLevelPlaylist.description && (
                        <div className="small mt-15 ellipsis-2-lines ellipsis">
                          {topLevelPlaylist.description}
                        </div>
                      )}
                    </h3>
                    <div>
                      {topLevelPlaylist.jspf?.playlist?.track.map(
                        (playlistTrack) => {
                          const listen = JSPFTrackToListen(playlistTrack);
                          listens.push(listen);
                          return (
                            <ListenCard
                              className="playlist-item-card"
                              listen={listen}
                              compact
                              showTimestamp={false}
                              showUsername={false}
                              newAlert={newAlert}
                            />
                          );
                        }
                      )}
                      <hr />
                      <a
                        href={`/playlist/${topLevelPlaylist.mbid}`}
                        className="btn btn-info btn-block"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        See the full playlist…
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <hr className="wide" />
        <BrainzPlayer
          listens={listens}
          newAlert={newAlert}
          listenBrainzAPIBaseURI={APIService.APIBaseURI}
          refreshSpotifyToken={APIService.refreshSpotifyToken}
          refreshYoutubeToken={APIService.refreshYoutubeToken}
        />
      </div>
    );
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const { domContainer, reactProps, globalReactProps } = getPageProps();
  const { api_url, current_user, spotify, youtube } = globalReactProps;
  const { user, data: yearInMusicData } = reactProps;

  const apiService = new APIServiceClass(
    api_url || `${window.location.origin}/1`
  );

  const YearInMusicWithAlertNotifications = withAlertNotifications(YearInMusic);

  const globalProps: GlobalAppContextT = {
    APIService: apiService,
    currentUser: current_user,
    spotifyAuth: spotify,
    youtubeAuth: youtube,
  };

  ReactDOM.render(
    <ErrorBoundary>
      <GlobalAppContext.Provider value={globalProps}>
        <YearInMusicWithAlertNotifications
          user={user}
          yearInMusicData={yearInMusicData}
        />
      </GlobalAppContext.Provider>
    </ErrorBoundary>,
    domContainer
  );
});
