import axios from 'axios';

export interface TMDBResult {
  id: number;
  title: string;
  year: string;
  poster: string | null;
  type: 'movie' | 'tv';
}

const TMDB_BASE   = 'https://api.themoviedb.org/3';
const POSTER_BASE = 'https://image.tmdb.org/t/p/w185';

export async function searchTMDB(query: string, type: 'movie' | 'tv'): Promise<TMDBResult[]> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error('TMDB_API_KEY not set in environment');

  const endpoint = type === 'movie' ? '/search/movie' : '/search/tv';
  const { data } = await axios.get(`${TMDB_BASE}${endpoint}`, {
    params: { api_key: apiKey, query, include_adult: false, page: 1 },
    timeout: 8_000,
  });

  return (data.results as any[]).slice(0, 8).map((r: any) => ({
    id:     r.id as number,
    title:  (type === 'movie' ? r.title : r.name) as string,
    year:   String(type === 'movie' ? r.release_date : r.first_air_date ?? '').slice(0, 4),
    poster: r.poster_path ? `${POSTER_BASE}${r.poster_path}` : null,
    type,
  }));
}
