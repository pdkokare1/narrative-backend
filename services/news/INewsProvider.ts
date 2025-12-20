import { INewsSourceArticle } from '../../types';

export interface INewsProvider {
    name: string;
    fetchArticles(params: any): Promise<INewsSourceArticle[]>;
}
